// cctabgaze host：被動待命。viewer 寫入 cg_req → 這裡被同步事件叫醒 → 有 Claude 分頁群組才回應
// chrome.debugger 只用 attach / detach / sendCommand，指令只有 Page.captureScreenshot 與 input() 裡固定的三種 Input.*；
// 分頁控制（網址、上一頁、切換、開啟、關閉）只在 control() 裡，且只作用在 Claude 分頁群組內的分頁
const REQ = 'cg_req', RES = 'cg_res';
const MIN_INTERVAL = 500, FAST_INTERVAL = 100, INPUT_BOOST = 2000, FALLBACK = 3000, SHOT_TIMEOUT = 5000, REQ_TTL = 60000;
const AI_TITLES = new Set(['Claude', 'Claude (MCP)']);
const PREFIX = /^(⌛|🔔|✅)\s*/;
const STATES = { '⌛': 'running', '🔔': 'permission', '✅': 'done' };

// ---- 診斷紀錄（viewer 頁面可顯示）----
let q = Promise.resolve();
const slog = (...a) => { q = q.then(async () => {
  const line = `[${new Date().toISOString().slice(11, 23)}] ` + a.join(' ');
  const { cg_log = [] } = await chrome.storage.local.get('cg_log');
  cg_log.push(line);
  await chrome.storage.local.set({ cg_log: cg_log.slice(-300) });
}); return q; };

// ---- 分頁活動時間：在多個 AI 分頁間穩定選擇 ----
const activity = new Map();
const touch = (id) => activity.set(id, Date.now());
chrome.tabs.onUpdated.addListener(touch);
chrome.tabs.onActivated.addListener(({ tabId }) => touch(tabId));
chrome.tabs.onRemoved.addListener((id) => activity.delete(id));

async function findClaudeGroups() {
  const groups = await chrome.tabGroups.query({});
  return groups.filter((g) => AI_TITLES.has((g.title || '').replace(PREFIX, '').trim()));
}
const stateOf = (title) => STATES[((title || '').match(PREFIX) || [])[1]] || 'idle';

const groupTabs = async (groups) => (await Promise.all(groups.map((g) => chrome.tabs.query({ groupId: g.id })))).flat();

function pickTab(tabs) { // 自動模式：最近有動靜的網頁分頁
  let best = null, bestAt = -1;
  for (const t of tabs) {
    if (!/^https?:/.test(t.url || '')) continue;
    const at = Math.max(t.lastAccessed || 0, activity.get(t.id) || 0);
    if (at > bestAt) { best = t; bestAt = at; }
  }
  return best;
}

// 分頁清單：有變才送給 viewer（標題、網址截斷，避免 data: 網址塞爆 DataChannel）
function sendTabs(s, tabs, cur) {
  const msg = { type: 'tabs', cur: cur?.id ?? null, pinned: s.pinnedTabId != null,
    tabs: tabs.slice(0, 40).map((t) => ({ id: t.id, title: str(t.title, 80), url: str(t.url, 2048) })) };
  const json = JSON.stringify(msg);
  if (json === s.lastTabs) return;
  s.lastTabs = json;
  toOff({ type: 'ctl', msg });
}

// ---- 連線階段 ----
let session = null; // { req, attachedTabId, lastData, lastStepAt, lastInputAt, view, pinnedTabId(null=自動跟隨 AI), cur(這輪選中的分頁), tabs, lastTabs }
let timer = null;
const toOff = (m) => chrome.runtime.sendMessage({ target: 'offscreen', ...m }).catch(() => {});

async function ensureOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (!ctx.length) await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['WEB_RTC'], justification: '與另一台電腦的 Chrome 建立 WebRTC 連線傳送畫面' });
}

const forgetTab = (s) => { s.attachedTabId = null; s.lastData = null; };

async function release() {
  if (session?.attachedTabId == null) return;
  const t = session.attachedTabId;
  forgetTab(session);
  try { await chrome.debugger.detach({ tabId: t }); } catch {}
}
const fastGap = (s) => Math.max(0, FAST_INTERVAL - (Date.now() - s.lastStepAt));
chrome.debugger.onDetach.addListener((src) => { if (src.tabId === session?.attachedTabId) forgetTab(session); });

async function endSession(reason) {
  const s = session;
  if (!s) return;
  session = null;
  clearTimeout(timer);
  slog('結束連線：', reason);
  await toOff({ type: 'end', reason });
  if (s.attachedTabId != null) chrome.debugger.detach({ tabId: s.attachedTabId }).catch(() => {});
  setTimeout(() => { if (!session) chrome.offscreen.closeDocument().catch(() => {}); }, 1500);
}

const shot = async (tabId) => (await Promise.race([
  chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', { format: 'jpeg', quality: 50 }),
  new Promise((_, rej) => setTimeout(() => rej(new Error('截圖逾時')), SHOT_TIMEOUT)),
])).data;

const schedule = (ms) => { clearTimeout(timer); timer = setTimeout(step, ms); };

async function step() {
  const s = session;
  if (!s) return;
  s.lastStepAt = Date.now();
  let sentFrame = false;
  try {
    const groups = await findClaudeGroups();
    if (!groups.length) return endSession('ai-ended');
    const tabs = s.tabs = await groupTabs(groups);
    if (!tabs.some((t) => t.id === s.pinnedTabId)) s.pinnedTabId = null; // 釘選的分頁不在了，回到自動
    const tab = tabs.find((t) => t.id === s.pinnedTabId) || pickTab(tabs);
    s.cur = tab?.id ?? null;
    sendTabs(s, tabs, tab); // 在 attach 之前送：釘到截不到的頁面時清單仍送得出，才切得走
    if (!tab) toOff({ type: 'ctl', msg: { type: 'error', message: 'Claude 分頁群組裡沒有可截圖的網頁分頁' } });
    else {
      s.view = { w: tab.width, h: tab.height };
      if (s.attachedTabId !== tab.id) { await release(); await chrome.debugger.attach({ tabId: tab.id }, '1.3'); s.attachedTabId = tab.id; }
      const state = stateOf((groups.find((g) => g.id === tab.groupId) || groups[0]).title);
      const data = await shot(tab.id);
      if (session !== s) return;
      if (data === s.lastData) toOff({ type: 'ctl', msg: { type: 'same', state } });
      else { s.lastData = data; sentFrame = true; toOff({ type: 'frame', b64: data, state, tabId: tab.id, ts: Date.now() }); }
    }
  } catch (e) {
    toOff({ type: 'ctl', msg: { type: 'error', message: String(e.message || e) } });
    await release();
  }
  const idleGap = Date.now() - s.lastInputAt < INPUT_BOOST ? FAST_INTERVAL : MIN_INTERVAL; // 剛有輸入就加快檢查
  if (session === s) schedule(sentFrame ? FALLBACK : idleGap); // 送了畫面就等 offscreen 回報「送完了」，再只等 FAST_INTERVAL
}

// ---- viewer 的滑鼠鍵盤：呼叫 debugger 前的唯一關口，參數一律從零組，不轉傳 viewer 的物件 ----
const num = (v, lo, hi, d = 0) => Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
const own = (o, k) => (typeof k === 'string' && Object.hasOwn(o, k) ? o[k] : undefined); // 避免 '__proto__'、'constructor' 這類鍵取到原型上的東西
const str = (v, n) => typeof v === 'string' ? v.slice(0, n) : '';
const MOUSE = { down: 'mousePressed', up: 'mouseReleased', move: 'mouseMoved', wheel: 'mouseWheel' };
const MASK = { left: 1, right: 2, middle: 4, none: 0 };
const EDIT = { a: 'selectAll', c: 'copy', x: 'cut', z: 'undo' }; // macOS 的編輯快捷鍵不會自己動作，要用 commands

function input(ev) {
  const s = session;
  if (!s || s.attachedTabId == null || !s.view || ev?.tabId !== s.attachedTabId) return; // 沒接上、或 viewer 看的是別的分頁
  const mod = num(ev.mod, 0, 15) | 0;
  let method, params;
  if (ev.type === 'mouse' && own(MOUSE, ev.a)) {
    const b = own(MASK, ev.b) === undefined ? 'none' : ev.b;
    method = 'Input.dispatchMouseEvent';
    params = { type: MOUSE[ev.a], x: num(ev.x, 0, 1) * s.view.w, y: num(ev.y, 0, 1) * s.view.h, button: b, buttons: ev.a === 'up' ? 0 : MASK[b], modifiers: mod };
    if (ev.a === 'down' || ev.a === 'up') params.clickCount = num(ev.n, 1, 3, 1) | 0;
    if (ev.a === 'wheel') { params.deltaX = num(ev.dx, -5000, 5000); params.deltaY = num(ev.dy, -5000, 5000); }
  } else if (ev.type === 'key' && (ev.a === 'down' || ev.a === 'up')) {
    const key = str(ev.key, 32), text = ev.a === 'down' ? str(ev.text, 8) : '';
    const vk = num(ev.vk, 0, 255) | 0;
    method = 'Input.dispatchKeyEvent';
    params = { type: ev.a === 'up' ? 'keyUp' : text ? 'keyDown' : 'rawKeyDown', modifiers: mod, key, code: str(ev.code, 32), windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    if (text) { params.text = text; params.unmodifiedText = text; }
    if (ev.a === 'down' && (mod & 4) && !(mod & 3)) { // 只有 Cmd，沒有 Alt/Ctrl
      const k = key.toLowerCase();
      const cmd = (mod & 8) && k === 'z' ? 'redo' : own(EDIT, k);
      if (cmd) params.commands = [cmd];
    }
  } else if (ev.type === 'text') {
    method = 'Input.insertText';
    params = { text: str(ev.text, 2000) };
  } else return;
  s.lastInputAt = Date.now();
  chrome.debugger.sendCommand({ tabId: s.attachedTabId }, method, params).catch(() => {}); // 不等回應；隱藏分頁可能不回
}

// ---- viewer 的分頁控制：和 input() 並列的關口。分流在 input() 的「已接上分頁」檢查之前，截不到的頁面也導得出來 ----
const fixUrl = (u) => { // 不像 scheme:// 也不是 about: 就補 https://，否則 Chrome 會當成擴充功能內的相對路徑
  const t = str(u, 2048).trim();
  return !t || /^([a-z][a-z0-9+.-]*:\/\/|about:)/i.test(t) ? t : 'https://' + t;
};
let controlQ = Promise.resolve(); // 串行化：連按兩次關閉不能都看到「還剩兩個」
const control = (ev) => { controlQ = controlQ.then(() => doControl(ev)).catch((e) => slog('控制失敗：', ev?.type, ev?.a, e.message || e)); };

async function doControl(ev) {
  const s = session;
  if (!s || !ev) return;
  const id = ev.tabId;
  if (ev.type === 'nav') {
    if (s.cur == null || id !== s.cur) return slog('導覽被丟棄：viewer 的分頁', id, '≠ 目前', s.cur); // 只作用在目前截的分頁；viewer 看的若是別的分頁就丟棄
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
      try { await chrome.tabs.group({ tabIds: t.id, groupId: base.groupId }); }
      catch { await chrome.tabs.remove(t.id).catch(() => {}); return; } // 不留群組外的孤兒分頁
      s.pinnedTabId = t.id;
    } else if (Number.isInteger(id) && s.tabs.some((t) => t.id === id)) { // 只認這一輪 Claude 群組裡的分頁
      if (ev.a === 'select') s.pinnedTabId = id;
      if (ev.a === 'close') {
        const gid = s.tabs.find((t) => t.id === id).groupId;
        if (s.tabs.filter((t) => t.groupId === gid).length < 2) return; // 關光群組會被當成 AI 結束
        s.tabs = s.tabs.filter((t) => t.id !== id);
        await chrome.tabs.remove(id);
      }
    }
  } else return;
  s.lastInputAt = Date.now(); // 沿用 INPUT_BOOST，下一輪很快生效；不另外踢 step()，避免兩個 step 並行互拔 debugger
}

// ---- 被動回應 viewer 的請求 ----
const reply = (req, body) => chrome.storage.sync.set({ [RES]: { to: req.from, id: req.id, t: Date.now(), ...body } });

async function onRequest(req) {
  const { role = 'host', deviceId } = await chrome.storage.local.get(['role', 'deviceId']);
  if (role !== 'host' || req.from === deviceId) return;
  const age = Date.now() - req.t;
  if (age > REQ_TTL) return slog('忽略過期的請求，已過', age, 'ms');
  slog('收到連線請求', req.id.slice(0, 8), '，延遲約', age, 'ms');
  if (!(await findClaudeGroups()).length) { await reply(req, { error: 'ai-idle' }); return slog('沒有 Claude 分頁群組，拒絕連線'); }
  await endSession('replaced');
  session = { req, attachedTabId: null, lastData: null, lastStepAt: 0, lastInputAt: 0, view: null, pinnedTabId: null, cur: null, tabs: [], lastTabs: null };
  await ensureOffscreen();
  for (let i = 0; i < 5; i++) {
    try { await chrome.runtime.sendMessage({ target: 'offscreen', type: 'offer', sdp: req.sdp, id: req.id }); return; }
    catch { await new Promise((r) => setTimeout(r, 300)); }
  }
  slog('offscreen 沒有回應');
}

chrome.storage.onChanged.addListener((ch, area) => {
  const req = area === 'sync' && ch[REQ]?.newValue;
  if (req) onRequest(req);
});

chrome.tabGroups.onRemoved.addListener(async () => { if (session && !(await findClaudeGroups()).length) endSession('ai-ended'); });

chrome.runtime.onMessage.addListener((m) => {
  if (m.target !== 'sw') return;
  if (m.type === 'log') slog('[offscreen]', m.line);
  if (m.type === 'input') (m.ev?.type === 'nav' || m.ev?.type === 'tab' ? control : input)(m.ev);
  if (m.type === 'answer' && session && m.id === session.req.id) reply(session.req, { sdp: m.sdp }).then(() => slog('answer 已寫入 sync'));
  if (m.type === 'open' && session) { slog('DataChannel 開啟，開始傳畫面'); schedule(0); }
  if (m.type === 'ready' && session) schedule(fastGap(session)); // ready 只會在送出畫面後出現
  if (m.type === 'closed') endSession('viewer-left');
});

importScripts('viewer-bg.js');
