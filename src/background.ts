// cctabgaze host：被動待命。viewer 寫入 cg_req → 這裡被同步事件叫醒 → 有 Claude 分頁群組才回應
// chrome.debugger 只用 attach / detach / sendCommand，指令只有 Page.captureScreenshot、input() 裡固定的三種 Input.*，以及複製用的一段寫死的 Runtime.evaluate；
// 分頁控制（網址、上一頁、切換、開啟、關閉）只在 control() 裡，且只作用在 Claude 分頁群組內的分頁
import './viewer-bg.ts'; // viewer 端的大腦，和 host 共用同一個背景程式
import { REQ, RES, slog, ensureOffscreen, errText } from './shared.ts';
import { startSignal } from './signal.ts';
import { DEFAULT_TUNE, parseTune } from './tune.ts';
import type { AiState, EndReason, Msg, OffBody, OfferMsg, Reply, Req, Res, Transport, Tune, Untrusted } from './protocol.ts';

type Tab = chrome.tabs.Tab;
type Group = chrome.tabGroups.TabGroup;
interface Session {
  req: Req;
  reply: Reply; // 回覆這個請求的管道（storage.sync 或信令伺服器）
  attachedTabId: number | null;
  lastData: string | null; // 已確認送達的最後一張
  pending: string | null; // 送出但還沒確認的畫面
  pendingAt: number;
  seq: number;
  pendingSeq: number;
  lastStepAt: number;
  lastInputAt: number;
  view: { w: number; h: number } | null;
  tune: Tune;
  videoOk: boolean; // 視訊軌協商成功且可用（offscreen 在 open 時回報；編碼壞了會被改回 false）
  perf: Perf;
  pinnedTabId: number | null; // null＝自動跟隨 AI
  cur: number | null; // 這輪選中的分頁
  tabs: Tab[];
  lastTabs: string | null;
  busy: boolean;
}

// 診斷用量測：每 5 秒在紀錄寫一行 host 自己的截圖速度與送達等待，看瓶頸在 host 還是網路（視訊編碼那一側由 offscreen 另外寫 [視訊]）
interface Perf { t0: number; shotN: number; shotMs: number; sent: number; same: number; waitN: number; waitMs: number; video: boolean }
const newPerf = (): Perf => ({ t0: Date.now(), shotN: 0, shotMs: 0, sent: 0, same: 0, waitN: 0, waitMs: 0, video: false });
function perfTick(s: Session) {
  const p = s.perf, dt = (Date.now() - p.t0) / 1000;
  if (dt < 5) return;
  if (p.shotN) slog('[perf] 截圖', (p.shotN / dt).toFixed(1), 'fps（每張', (p.shotMs / p.shotN).toFixed(0), 'ms）；送出', (p.sent / dt).toFixed(1), 'fps，沒變', p.same, '次；送達等待平均', p.waitN ? (p.waitMs / p.waitN).toFixed(0) : '-', 'ms；模式', p.video ? '視訊' : '圖片');
  s.perf = newPerf();
}

// 畫面設定由 viewer 的懸浮視窗選、經 DataChannel 送來（tune 訊息），這裡只接受白名單內的值
const VIDEO_SHOT: Tune = { ...DEFAULT_TUNE, quality: 90 }; // 視訊模式的截圖：JPEG 90 和 PNG 一樣快，比 50 少一次重壓損失
const MIN_INTERVAL = 500, INPUT_BOOST = 2000, FALLBACK = 3000, PENDING_TTL = 10000, SHOT_TIMEOUT = 5000, REQ_TTL = 60000;
const AI_TITLES = new Set(['Claude', 'Claude (MCP)']);
const PREFIX = /^(⌛|🔔|✅)\s*/;
const STATES: Record<string, AiState> = { '⌛': 'running', '🔔': 'permission', '✅': 'done' };

// ---- 分頁活動時間：在多個 AI 分頁間穩定選擇 ----
const activity = new Map<number, number>();
const touch = (id: number) => activity.set(id, Date.now());
chrome.tabs.onUpdated.addListener(touch);
chrome.tabs.onActivated.addListener(({ tabId }) => touch(tabId));
chrome.tabs.onRemoved.addListener((id) => activity.delete(id));

async function findClaudeGroups(): Promise<Group[]> {
  const groups = await chrome.tabGroups.query({});
  return groups.filter((g) => AI_TITLES.has((g.title || '').replace(PREFIX, '').trim()));
}
const stateOf = (title: string | undefined): AiState => STATES[((title || '').match(PREFIX) || [])[1] ?? ''] || 'idle';

const groupTabs = async (groups: Group[]) => (await Promise.all(groups.map((g) => chrome.tabs.query({ groupId: g.id })))).flat();

function pickTab(tabs: Tab[]): Tab | null { // 自動模式：最近有動靜的網頁分頁
  let best: Tab | null = null, bestAt = -1;
  for (const t of tabs) {
    if (!/^https?:/.test(t.url || '')) continue;
    const at = Math.max(t.lastAccessed || 0, (t.id != null && activity.get(t.id)) || 0);
    if (at > bestAt) { best = t; bestAt = at; }
  }
  return best;
}

// 分頁清單：有變才送給 viewer（標題、網址截斷，避免 data: 網址塞爆 DataChannel）
function sendTabs(s: Session, tabs: Tab[], cur: Tab | null | undefined) {
  const msg = { type: 'tabs' as const, cur: cur?.id ?? null, pinned: s.pinnedTabId != null,
    tabs: tabs.slice(0, 40).map((t) => ({ id: t.id, title: str(t.title, 80), url: str(t.url, 2048) })) };
  const json = JSON.stringify(msg);
  if (json === s.lastTabs) return;
  s.lastTabs = json;
  toOff({ type: 'ctl', msg }, s);
}

// ---- 連線階段 ----
let session: Session | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const toOff = (m: OffBody, s: Session | null = session) => chrome.runtime.sendMessage({ target: 'offscreen', id: s?.req.id, ...m }).catch(() => {}); // 帶連線編號，offscreen 只認目前那條

const forgetTab = (s: Session) => { s.attachedTabId = null; s.lastData = null; s.pending = null; };

async function release(s: Session) {
  if (s.attachedTabId == null) return;
  const t = s.attachedTabId;
  forgetTab(s);
  try { await chrome.debugger.detach({ tabId: t }); } catch {}
}
const fastGap = (s: Session) => Math.max(0, s.tune.fast - (Date.now() - s.lastStepAt));
chrome.debugger.onDetach.addListener((src, reason) => {
  if (!session || src.tabId !== session.attachedTabId) return;
  if (reason === 'canceled_by_user') return void endSession('host-canceled'); // host 端的人在提示列按了「取消」：尊重，結束這次連線
  forgetTab(session); // 分頁被關等其他原因：下一輪重選
});

async function endSession(reason: EndReason) {
  const s = session;
  if (!s) return;
  session = null;
  clearTimeout(timer);
  slog('結束連線：', reason);
  await toOff({ type: 'end', reason }, s);
  if (s.attachedTabId != null) chrome.debugger.detach({ tabId: s.attachedTabId }).catch(() => {});
}

async function shot(tabId: number, { format, quality }: Tune): Promise<string> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return ((await Promise.race([
      chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', { format, ...(format !== 'png' && { quality }) }), // png 沒有品質參數
      new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error('截圖逾時')), SHOT_TIMEOUT); }),
    ])) as { data: string }).data;
  } finally { clearTimeout(t); }
}

const schedule = (ms: number) => { clearTimeout(timer); timer = setTimeout(step, ms); };

async function step() { // 單飛：備援計時器與 ready 同時觸發時，不能有兩個 step 並行互拔 debugger
  const s = session;
  if (!s || s.busy) return;
  s.busy = true;
  try { await stepOnce(s); } finally { s.busy = false; }
}

async function stepOnce(s: Session) {
  s.lastStepAt = Date.now();
  perfTick(s);
  let sentFrame = false;
  try {
    const groups = await findClaudeGroups();
    if (!groups.length) return endSession('ai-ended');
    const tabs = s.tabs = await groupTabs(groups);
    if (!tabs.some((t) => t.id === s.pinnedTabId)) s.pinnedTabId = null; // 釘選的分頁不在了，回到自動
    const tab = tabs.find((t) => t.id === s.pinnedTabId) || pickTab(tabs);
    const tabId = tab?.id;
    s.cur = tabId ?? null;
    sendTabs(s, tabs, tab); // 在 attach 之前送：釘到截不到的頁面時清單仍送得出，才切得走
    if (!tab || tabId == null) toOff({ type: 'ctl', msg: { type: 'error', message: 'Claude 分頁群組裡沒有可截圖的網頁分頁' } }, s);
    else {
      s.view = tab.width && tab.height ? { w: tab.width, h: tab.height } : null;
      if (s.attachedTabId !== tabId) {
        await release(s);
        await chrome.debugger.attach({ tabId }, '1.3');
        s.attachedTabId = tabId;
        if (session !== s) return release(s); // attach 的空窗期間連線已結束，不能留下沒人管的 debugger
      }
      const state = stateOf((groups.find((g) => g.id === tab.groupId) || groups[0])?.title);
      if (s.pending == null || Date.now() - s.pendingAt >= PENDING_TTL) { // 上一張還沒確認送完就不截新的；超過 PENDING_TTL 視為遺失，重送
        const video = s.tune.mode === 'video' && s.videoOk; // 整個背景程式只有這裡讀 mode
        const cfg = video ? VIDEO_SHOT : s.tune; // 這一張用的設定；中途被改了也不影響這張的格式標記
        const t0 = Date.now();
        const data = await shot(tabId, cfg);
        s.perf.shotN++; s.perf.shotMs += Date.now() - t0; s.perf.video = video;
        if (session !== s) return;
        if (data === s.lastData) { s.perf.same++; toOff({ type: 'ctl', msg: { type: 'same', state } }, s); }
        else {
          s.perf.sent++;
          s.pending = data; s.pendingAt = Date.now(); s.pendingSeq = ++s.seq; sentFrame = true;
          toOff({ type: 'frame', b64: data, state, tabId, ts: Date.now(), seq: s.seq, fmt: cfg.format, video, vw: s.view?.w ?? 0 }, s);
        }
      }
    }
  } catch (e) {
    toOff({ type: 'ctl', msg: { type: 'error', message: errText(e) } }, s);
    await release(s);
  }
  const idleGap = Date.now() - s.lastInputAt < INPUT_BOOST ? s.tune.fast : MIN_INTERVAL; // 剛有輸入就加快檢查
  if (session === s) schedule(sentFrame ? FALLBACK : idleGap); // 送了畫面就等 offscreen 回報「送完了」，再只等 tune.fast
}

// ---- viewer 的滑鼠鍵盤：呼叫 debugger 前的唯一關口，參數一律從零組，不轉傳 viewer 的物件 ----
const rec = (v: unknown): Untrusted | null => (typeof v === 'object' && v !== null ? v as Untrusted : null);
const num = (v: unknown, lo: number, hi: number, d = 0) => typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
const hasKey = <O extends object>(o: O, k: unknown): k is keyof O & string => typeof k === 'string' && Object.hasOwn(o, k); // 避免 '__proto__'、'constructor' 這類鍵取到原型上的東西
const str = (v: unknown, n: number) => typeof v === 'string' ? v.slice(0, n) : '';
const MOUSE = { down: 'mousePressed', up: 'mouseReleased', move: 'mouseMoved', wheel: 'mouseWheel' };
const MASK = { left: 1, right: 2, middle: 4, none: 0 };
// 複製：讀目前選取的文字（輸入框取反白的部分；密碼欄位不讀）。這段是常數，不接受 viewer 傳來的任何程式碼
const COPY_EXPR = `(() => { const a = document.activeElement; if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) return a.type === 'password' ? '' : String(a.value).slice(a.selectionStart, a.selectionEnd); return String(getSelection()); })()`;
const COPY_MAX = 50000; // 單筆 DataChannel 訊息上限約 256KB，中文 JSON 一字 3 位元組，留餘裕
const EDIT = { a: 'selectAll', c: 'copy', x: 'cut', z: 'undo' }; // macOS 的編輯快捷鍵不會自己動作，要用 commands

function input(ev: Untrusted | null) {
  const s = session;
  if (!s || s.attachedTabId == null || !s.view || ev?.tabId !== s.attachedTabId) return; // 沒接上、或 viewer 看的是別的分頁
  if (ev.type === 'copy') {
    s.lastInputAt = Date.now();
    chrome.debugger.sendCommand({ tabId: s.attachedTabId }, 'Runtime.evaluate', { expression: COPY_EXPR, returnByValue: true })
      .then((r) => { const t = (r as { result?: { value?: unknown } } | undefined)?.result?.value; if (typeof t === 'string' && t && session === s) toOff({ type: 'ctl', msg: { type: 'copied', text: t.slice(0, COPY_MAX) } }, s); })
      .catch(() => {});
    return;
  }
  const mod = num(ev.mod, 0, 15) | 0;
  const a = ev.a;
  let method: string, params: Record<string, unknown>;
  if (ev.type === 'mouse' && hasKey(MOUSE, a)) {
    const b = hasKey(MASK, ev.b) ? ev.b : 'none';
    method = 'Input.dispatchMouseEvent';
    params = { type: MOUSE[a], x: num(ev.x, 0, 1) * s.view.w, y: num(ev.y, 0, 1) * s.view.h, button: b, buttons: a === 'up' ? 0 : MASK[b], modifiers: mod };
    if (a === 'down' || a === 'up') params.clickCount = num(ev.n, 1, 3, 1) | 0;
    if (a === 'wheel') { params.deltaX = num(ev.dx, -5000, 5000); params.deltaY = num(ev.dy, -5000, 5000); }
  } else if (ev.type === 'key' && (a === 'down' || a === 'up')) {
    const key = str(ev.key, 32), text = a === 'down' ? str(ev.text, 8) : '';
    const vk = num(ev.vk, 0, 255) | 0;
    method = 'Input.dispatchKeyEvent';
    params = { type: a === 'up' ? 'keyUp' : text ? 'keyDown' : 'rawKeyDown', modifiers: mod, key, code: str(ev.code, 32), windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    if (text) { params.text = text; params.unmodifiedText = text; }
    if (a === 'down' && (mod & 4) && !(mod & 3)) { // 只有 Cmd，沒有 Alt/Ctrl
      const k = key.toLowerCase();
      const cmd = (mod & 8) && k === 'z' ? 'redo' : hasKey(EDIT, k) ? EDIT[k] : undefined;
      if (cmd) params.commands = [cmd];
    }
  } else if (ev.type === 'text') {
    method = 'Input.insertText';
    params = { text: str(ev.text, 2000) };
  } else return;
  s.lastInputAt = Date.now();
  chrome.debugger.sendCommand({ tabId: s.attachedTabId }, method, params).catch(() => {}); // 不等回應；隱藏分頁可能不回
}

// ---- viewer 的畫面設定：只認白名單內的值，其餘用預設 ----
function tune(ev: Untrusted) {
  if (!session) return;
  session.tune = parseTune(ev);
  session.lastData = null; // 換了格式或品質，下一張不能和舊的比對
  slog('畫面設定：', JSON.stringify(session.tune));
}

// ---- viewer 的分頁控制：和 input() 並列的關口。分流在 input() 的「已接上分頁」檢查之前，截不到的頁面也導得出來 ----
const fixUrl = (u: unknown) => { // 不像 scheme:// 也不是 about: 就補 https://，否則 Chrome 會當成擴充功能內的相對路徑
  const t = str(u, 2048).trim();
  return !t || /^([a-z][a-z0-9+.-]*:\/\/|about:)/i.test(t) ? t : 'https://' + t;
};
let controlQ: Promise<void> = Promise.resolve(); // 串行化：連按兩次關閉不能都看到「還剩兩個」
const control = (ev: Untrusted) => { controlQ = controlQ.then(() => doControl(ev)).catch((e) => { slog('控制失敗：', ev.type, ev.a, errText(e)); }); };

async function doControl(ev: Untrusted): Promise<void> {
  const s = session;
  if (!s) return;
  const id = ev.tabId;
  if (ev.type === 'nav') {
    if (s.cur == null || id !== s.cur) return void slog('導覽被丟棄：viewer 的分頁', id, '≠ 目前', s.cur); // 只作用在目前截的分頁；viewer 看的若是別的分頁就丟棄
    if (ev.a === 'go') { const url = fixUrl(ev.url); if (!url) return; await chrome.tabs.update(id, { url }); s.pinnedTabId = id; } // 釘住它，否則導向非網頁後自動模式會跳走
    else if (ev.a === 'back') await chrome.tabs.goBack(id);
    else if (ev.a === 'forward') await chrome.tabs.goForward(id);
    else if (ev.a === 'reload') await chrome.tabs.reload(id);
  } else if (ev.type === 'tab') {
    if (ev.a === 'auto') s.pinnedTabId = null;
    else if (ev.a === 'open') {
      const base = s.tabs.find((t) => t.id === s.cur) || s.tabs[0];
      if (!base) return;
      const t = await chrome.tabs.create({ windowId: base.windowId, index: base.index + 1, url: 'about:blank', active: false });
      if (t.id == null) return;
      try { await chrome.tabs.group({ tabIds: t.id, groupId: base.groupId }); }
      catch { await chrome.tabs.remove(t.id).catch(() => {}); return; } // 不留群組外的孤兒分頁
      s.pinnedTabId = t.id;
    } else if (typeof id === 'number' && Number.isInteger(id)) { // 只認這一輪 Claude 群組裡的分頁
      const target = s.tabs.find((t) => t.id === id);
      if (!target) return;
      if (ev.a === 'select') s.pinnedTabId = id;
      if (ev.a === 'close') {
        if (s.tabs.filter((t) => t.groupId === target.groupId).length < 2) return; // 關光群組會被當成 AI 結束
        s.tabs = s.tabs.filter((t) => t.id !== id);
        await chrome.tabs.remove(id);
      }
    }
  } else return;
  s.lastInputAt = Date.now(); // 沿用 INPUT_BOOST，下一輪很快生效；不另外踢 step()，避免兩個 step 並行互拔 debugger
}

// ---- 被動回應 viewer 的請求 ----
const syncTransport = (req: Req): Transport => ({
  lax: false,
  stale: async () => (await chrome.storage.sync.get<{ [REQ]: Req }>(REQ))[REQ]?.id !== req.id, // 排隊期間 viewer 可能已重按或放棄
  reply: (body) => {
    const item = { [RES]: { to: req.from, id: req.id, t: Date.now(), ...body } satisfies Res };
    if (body.sdp) slog('answer 字串化長度', JSON.stringify(item).length); // 同步的單筆上限約 8 KB（按字串化後算）
    return chrome.storage.sync.set(item);
  },
});

async function onRequest(req: Req, { reply, lax, stale }: Transport) {
  const { role = 'host', deviceId } = await chrome.storage.local.get<{ role: string; deviceId: string }>(['role', 'deviceId']);
  if (role !== 'host' || req.from === deviceId) return;
  if (await stale?.()) return slog('略過已被取代或撤回的請求', req.id.slice(0, 8));
  const age = Date.now() - req.t;
  if (age > REQ_TTL) return slog('忽略過期的請求，已過', age, 'ms');
  slog('收到連線請求', req.id.slice(0, 8), lax ? '（信令伺服器）' : '（同步）', '，延遲約', age, 'ms');
  if (!(await findClaudeGroups()).length) { await reply({ error: 'ai-idle' }); return slog('沒有 Claude 分頁群組，拒絕連線'); }
  await endSession('replaced');
  const { nets } = await chrome.storage.local.get<{ nets: unknown }>('nets'); // 允許的網段（各機器本機設定，不經同步）
  session = { req, reply, attachedTabId: null, lastData: null, pending: null, pendingAt: 0, seq: 0, pendingSeq: 0, lastStepAt: 0, lastInputAt: 0, view: null, tune: DEFAULT_TUNE, videoOk: false, perf: newPerf(), pinnedTabId: null, cur: null, tabs: [], lastTabs: null, busy: false };
  for (let i = 0; i < 5; i++) {
    try { await ensureOffscreen(); await chrome.runtime.sendMessage({ target: 'offscreen', type: 'offer', sdp: req.sdp, id: req.id, nets, lax } satisfies OfferMsg); return; } // 每輪都確認文件還在（它可能剛好自己關掉）
    catch { await new Promise((r) => setTimeout(r, 300)); }
  }
  slog('offscreen 沒有回應');
}

let reqQ: Promise<void> = Promise.resolve(); // 串行：兩個請求接連到達時不能同時建立 offscreen
chrome.storage.onChanged.addListener((ch, area) => {
  const req = area === 'sync' && ch[REQ]?.newValue as Req | undefined;
  if (req) queueRequest(req, syncTransport(req));
});
const queueRequest = (req: Req, t: Transport) => { reqQ = reqQ.then(() => onRequest(req, t)).catch((e) => { slog('處理請求失敗：', errText(e)); }); };

chrome.tabGroups.onRemoved.addListener(async () => { if (session && !(await findClaudeGroups()).length) endSession('ai-ended'); });

chrome.runtime.onMessage.addListener((m: Msg) => {
  if (m.target !== 'sw') return;
  if (m.type === 'log') return slog('[offscreen]', m.line);
  if (m.type === 'idle') return chrome.offscreen.closeDocument().catch(() => {}); // offscreen 自己回報兩條連線都沒了
  if (m.type.startsWith('v-') || !session || m.id !== session.req.id) return; // 其餘一律要帶目前這條連線的編號，viewer 端的 v-* 由 viewer-bg.ts 處理
  if (m.type === 'input') { // 不可信的資料從這裡分流到三個關口
    const ev = rec(m.ev);
    if (ev?.type === 'tune') tune(ev); else if (ev?.type === 'nav' || ev?.type === 'tab') control(ev); else input(ev);
  }
  if (m.type === 'answer') { // 送不出去要明講（sync 單筆上限約 8 KB），不能讓 viewer 乾等 20 秒
    const reply = session.reply;
    reply({ sdp: m.sdp }).then(() => slog('answer 已送出'), (e) => { slog('answer 送出失敗：', errText(e)); reply({ error: 'too-big' }).catch(() => {}); });
  }
  if (m.type === 'answer-failed') { session.reply({ error: m.reason || 'failed' }).catch(() => {}); endSession('answer-failed'); } // 不讓 viewer 乾等 20 秒
  if (m.type === 'open') { session.videoOk = m.video; slog('DataChannel 開啟，開始傳畫面，視訊', m.video); schedule(0); }
  if (m.type === 'video-failed') { session.videoOk = false; slog('視訊編碼失敗，改用圖片'); }
  if (m.type === 'ready' && m.seq === session.pendingSeq && session.pending != null) { // 這張確認送達，才算「已送出的最後一張」
    session.perf.waitN++; session.perf.waitMs += Date.now() - session.pendingAt;
    session.lastData = session.pending; session.pending = null;
    perfTick(session);
    schedule(fastGap(session));
  }
  if (m.type === 'closed') endSession('viewer-left');
});

// 背景程式（重新）啟動時：它不記得任何連線，所以殘留的 debugger 與 offscreen 的 host 連線都要收掉。
// 排在請求佇列的第一環，之後才處理喚醒它的那個請求。detach 對別的擴充功能（Claude）或開發者工具接上的分頁只會失敗。
reqQ = reqQ.then(async () => {
  for (const t of await chrome.debugger.getTargets()) if (t.attached && t.tabId) await chrome.debugger.detach({ tabId: t.tabId }).catch(() => {});
  toOff({ type: 'reset' }, null);
}).catch(() => {});

// 第一次安裝（不含更新與重新載入）：開說明頁，告訴使用者接下來要做什麼
chrome.runtime.onInstalled.addListener(({ reason }) => { if (reason === 'install') chrome.tabs.create({ url: 'welcome.html' }).catch(() => {}); });

// 信令伺服器：收到 offer 就排進同一條請求佇列，和 sync 的請求走同一條路徑。t 用收到的時間，不用伺服器的（避免兩邊時鐘差造成誤判過期）
startSignal((o, reply) => queueRequest({ id: o.id, from: 'signal', t: Date.now(), sdp: o.sdp }, { reply, lax: true }));
