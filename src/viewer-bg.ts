// viewer 端的大腦（由 background.ts 載入）：經 sync 向 host 發請求，WebRTC 在 offscreen 跑，
// 第一張畫面到了才開（或切到）檢視分頁，連線成功前使用者看不到任何分頁
import { REQ, RES, slog, ensureOffscreen, errText } from './shared.ts';
import type { Msg, Req, Res, Tune, VoffBody, VoffMsg } from './protocol.ts';

interface ViewSession {
  id: string;
  myId: string;
  focus: boolean;
  retried: boolean;
  ended: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  opening: Promise<void> | null;
  tuneSent: boolean;
}

const VIEWER_URL = chrome.runtime.getURL('viewer.html');
const STATE_TEXT: Record<string, string> = { running: '⌛ AI 執行中', permission: '🔔 AI 等待授權', done: '✅ AI 已完成', idle: 'AI 閒置' };
const END_TEXT: Record<string, string> = { 'ai-ended': 'AI 已結束', replaced: '已被另一台 viewer 取代', 'host-canceled': 'host 端取消了連線' }; // host 結束連線的原因，這幾種都不自動重連
const ERROR_TEXT: Record<string, string> = { 'ai-idle': 'AI 目前沒有在運作（host 沒有 Claude 分頁群組）', 'no-net': 'host 沒有符合允許網段的位址，無法連線', 'too-big': '連線資料超過同步上限（host 的回應太大）' };
let vs: ViewSession | null = null;
let lastStatus = '';
const vStatus = (t: string) => { if (t !== lastStatus) { lastStatus = t; chrome.storage.local.set({ cg_status: t }); } };

async function toVoff(m: VoffBody) {
  for (let i = 0; i < 10; i++) {
    try { await ensureOffscreen(); return await chrome.runtime.sendMessage({ target: 'voff', ...m } satisfies VoffMsg); } // 每輪都確認文件還在（它可能剛好自己關掉）
    catch { await new Promise((r) => setTimeout(r, 300)); }
  }
  slog('viewer offscreen 沒有回應');
}

async function vConnect(auto = false) {
  const prev = vs;
  clearTimeout(prev?.timer);
  let { deviceId, nets } = await chrome.storage.local.get<{ deviceId: string; nets: unknown }>(['deviceId', 'nets']);
  if (!deviceId) { deviceId = crypto.randomUUID(); await chrome.storage.local.set({ deviceId }); }
  const s: ViewSession = vs = { id: crypto.randomUUID(), myId: deviceId, focus: !auto, retried: auto && !!prev?.retried, ended: false, timer: undefined, opening: null, tuneSent: false };
  vStatus('連線中…（約需 10 秒）');
  await toVoff({ type: 'start', id: s.id, nets });
  if (vs === s) s.timer = setTimeout(() => vFail('host 離線或未回應（等了 20 秒）'), 20000);
}

function vStop(text: string) { // 使用者這邊的原因（關了檢視頁面、切回 host）：停止連線，也不要自動重連
  if (vs) vs.ended = true;
  vFail(text);
}

function vFail(text: string) {
  clearTimeout(vs?.timer);
  vStatus(text);
  chrome.storage.sync.remove([REQ, RES]);
  toVoff({ type: 'stop', id: vs?.id });
}

async function sendTune() { // 把懸浮視窗選的畫面設定送給 host；沒選過就不送，host 用預設值
  const { tune } = await chrome.storage.local.get<{ tune: Tune }>('tune');
  if (tune) toVoff({ type: 'input', ev: { type: 'tune', ...tune } });
}

async function showViewer(focus: boolean) {
  const [t] = await chrome.tabs.query({ url: VIEWER_URL });
  if (!t) { const n = await chrome.tabs.create({ url: VIEWER_URL, active: focus }); if (focus) await chrome.windows.update(n.windowId, { focused: true }); return; }
  if (!focus || t.id == null) return;
  await chrome.tabs.update(t.id, { active: true });
  await chrome.windows.update(t.windowId, { focused: true });
}

chrome.storage.onChanged.addListener((ch, area) => {
  const r = area === 'sync' && ch[RES]?.newValue as Res | undefined;
  if (!r || !vs || r.to !== vs.myId || r.id !== vs.id) return;
  clearTimeout(vs.timer);
  slog('[viewer] 收到 host 回應', r.error || 'answer');
  if (r.error || !r.sdp) return vFail(ERROR_TEXT[r.error ?? ''] || 'host 無法建立連線');
  const s = vs;
  s.timer = setTimeout(() => vFail('host 回應了，但連線建立失敗（等了 15 秒）'), 15000); // 回應之後另起一段，不再沿用 20 秒
  toVoff({ type: 'answer', id: s.id, sdp: r.sdp });
});

const FROM_VOFF = new Set(['v-offer', 'v-connected', 'v-closed', 'v-pagegone', 'v-netfail']);
chrome.runtime.onMessage.addListener((m: Msg) => {
  if (m.target === 'sw' && m.type === 'v-closed' && !vs) vStatus('連線中斷，請從插件圖示按 Viewer 重試'); // 背景程式重啟後 vs 已遺失，至少讓狀態文字更新
  if (m.target === 'sw' && FROM_VOFF.has(m.type) && m.id !== vs?.id) return; // 不是目前這條連線的訊息
  if (m.target === 'sw' && m.type === 'v-pagegone') return vStop('檢視頁面已關閉，連線已停止');
  if (m.target === 'sw' && m.type === 'v-netfail') return vStop(`連線位址不在允許網段內，已關閉（${m.detail}）`); // 位址不合是設定問題，重試也一樣，不自動重連
  if (m.target === 'sw' && m.type === 'v-connect') vConnect().catch((e) => vFail('錯誤：' + errText(e)));
  if (m.target === 'sw' && m.type === 'v-offer' && vs) {
    if (!m.kept) return vFail('這台沒有符合允許網段的位址，無法連線');
    const req = { id: vs.id, from: vs.myId, t: Date.now(), sdp: m.sdp } satisfies Req;
    slog('[viewer] 連線請求字串化長度', JSON.stringify({ [REQ]: req }).length); // 同步單筆上限約 8 KB，按字串化後算
    chrome.storage.sync.set({ [REQ]: req }).then(() => slog('[viewer] 連線請求已寫入 sync'), (e) => { slog('[viewer] 連線請求寫入失敗：', errText(e)); vFail('連線資料超過同步上限，無法連線'); });
  }
  if (m.target === 'sw' && m.type === 'v-connected' && vs) {
    clearTimeout(vs.timer);
    vStatus('已連線，等待畫面…');
    chrome.storage.sync.remove([REQ, RES]);
  }
  if (m.target === 'sw' && m.type === 'v-closed' && vs && !vs.ended) {
    if (m.connected && !vs.retried) {
      const s = vs;
      s.retried = true; vStatus('連線中斷，5 秒後自動重連…');
      s.timer = setTimeout(() => { if (vs === s && !s.ended) vConnect(true); }, 5000); // 這 5 秒內使用者重按或關頁面都能取消
    }
    else vFail('連線失敗或中斷，請從插件圖示按 Viewer 重試');
  }
  if (m.target !== 'viewer' || !vs) return;
  if (!vs.tuneSent) { vs.tuneSent = true; sendTune(); } // 收到 host 第一筆資料才送：這時 host 已通過位址檢查，會接受設定
  vs.retried = false; // 收到 host 的資料才算連線真的成功，自動重連的額度才還原
  if (m.type === 'frame') { vs.opening ??= showViewer(vs.focus); vStatus(STATE_TEXT[m.state] || ''); }
  if (m.type === 'same') vStatus(STATE_TEXT[m.state] || lastStatus);
  if (m.type === 'error') vStatus('無法顯示');
  if (m.type === 'end') { vs.ended = true; vStatus(END_TEXT[m.reason] || '連線已結束'); }
});

chrome.storage.onChanged.addListener((ch, area) => { // 切回 host 角色：viewer 的連線停止
  if (area === 'local' && ch.role?.newValue === 'host' && vs) vStop('已切回 host，連線已停止');
});

chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.tune && vs?.tuneSent && !vs.ended) sendTune(); }); // 連線中改設定，馬上生效
