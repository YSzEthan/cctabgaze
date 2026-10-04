// viewer 端的大腦（由 background.js 載入）：經 sync 向 host 發請求，WebRTC 在 offscreen 跑，
// 第一張畫面到了才開（或切到）檢視分頁，連線成功前使用者看不到任何分頁
const VIEWER_URL = chrome.runtime.getURL('viewer.html');
const STATE_TEXT = { running: '⌛ AI 執行中', permission: '🔔 AI 等待授權', done: '✅ AI 已完成', idle: 'AI 閒置' };
const END_TEXT = { 'ai-ended': 'AI 已結束', replaced: '已被另一台 viewer 取代', 'host-canceled': 'host 端取消了連線' }; // host 結束連線的原因，這幾種都不自動重連
let vs = null; // { id, myId, focus, retried, ended, timer, opening }
let lastStatus = '';
const vStatus = (t) => { if (t !== lastStatus) { lastStatus = t; chrome.storage.local.set({ cg_status: t }); } };

async function toVoff(m) {
  for (let i = 0; i < 10; i++) {
    try { await ensureOffscreen(); return await chrome.runtime.sendMessage({ target: 'voff', ...m }); } // 每輪都確認文件還在（它可能剛好自己關掉）
    catch { await new Promise((r) => setTimeout(r, 300)); }
  }
  slog('viewer offscreen 沒有回應');
}

async function vConnect(auto = false) {
  const prev = vs;
  clearTimeout(prev?.timer);
  let { deviceId } = await chrome.storage.local.get('deviceId');
  if (!deviceId) { deviceId = crypto.randomUUID(); await chrome.storage.local.set({ deviceId }); }
  const s = vs = { id: crypto.randomUUID(), myId: deviceId, focus: !auto, retried: auto && !!prev?.retried, ended: false, timer: null, opening: null };
  vStatus('連線中…（約需 10 秒）');
  await toVoff({ type: 'start', id: s.id });
  if (vs === s) s.timer = setTimeout(() => vFail('host 離線或未回應（等了 20 秒）'), 20000);
}

function vStop(text) { // 使用者這邊的原因（關了檢視頁面、切回 host）：停止連線，也不要自動重連
  if (vs) vs.ended = true;
  vFail(text);
}

function vFail(text) {
  clearTimeout(vs?.timer);
  vStatus(text);
  chrome.storage.sync.remove([REQ, RES]);
  toVoff({ type: 'stop', id: vs?.id });
}

async function showViewer(focus) {
  const [t] = await chrome.tabs.query({ url: VIEWER_URL });
  if (!t) { const n = await chrome.tabs.create({ url: VIEWER_URL, active: focus }); if (focus) await chrome.windows.update(n.windowId, { focused: true }); return; }
  if (!focus) return;
  await chrome.tabs.update(t.id, { active: true });
  await chrome.windows.update(t.windowId, { focused: true });
}

chrome.storage.onChanged.addListener((ch, area) => {
  const r = area === 'sync' && ch[RES]?.newValue;
  if (!r || !vs || r.to !== vs.myId || r.id !== vs.id) return;
  clearTimeout(vs.timer);
  slog('[viewer] 收到 host 回應', r.error || 'answer');
  if (r.error) return vFail(r.error === 'ai-idle' ? 'AI 目前沒有在運作（host 沒有 Claude 分頁群組）' : 'host 無法建立連線');
  const s = vs;
  s.timer = setTimeout(() => vFail('host 回應了，但連線建立失敗（等了 15 秒）'), 15000); // 回應之後另起一段，不再沿用 20 秒
  toVoff({ type: 'answer', id: s.id, sdp: r.sdp });
});

const FROM_VOFF = new Set(['v-offer', 'v-connected', 'v-closed', 'v-pagegone']);
chrome.runtime.onMessage.addListener((m) => {
  if (m.target === 'sw' && m.type === 'v-closed' && !vs) vStatus('連線中斷，請從插件圖示按 Viewer 重試'); // 背景程式重啟後 vs 已遺失，至少讓狀態文字更新
  if (m.target === 'sw' && FROM_VOFF.has(m.type) && m.id !== vs?.id) return; // 不是目前這條連線的訊息
  if (m.target === 'sw' && m.type === 'v-pagegone') return vStop('檢視頁面已關閉，連線已停止');
  if (m.target === 'sw' && m.type === 'v-connect') vConnect().catch((e) => vFail('錯誤：' + (e.message || e)));
  if (m.target === 'sw' && m.type === 'v-offer' && vs) {
    if (!m.kept) return vFail('這台沒有 Tailscale 位址，無法連線');
    chrome.storage.sync.set({ [REQ]: { id: vs.id, from: vs.myId, t: Date.now(), sdp: m.sdp } }).then(() => slog('[viewer] 連線請求已寫入 sync'));
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
  vs.retried = false; // 收到 host 的資料才算連線真的成功，自動重連的額度才還原
  if (m.type === 'frame') { vs.opening ??= showViewer(vs.focus); vStatus(STATE_TEXT[m.state] || ''); }
  if (m.type === 'same') vStatus(STATE_TEXT[m.state] || lastStatus);
  if (m.type === 'error') vStatus('無法顯示');
  if (m.type === 'end') { vs.ended = true; vStatus(END_TEXT[m.reason] || '連線已結束'); }
});

chrome.storage.onChanged.addListener((ch, area) => { // 切回 host 角色：viewer 的連線停止
  if (area === 'local' && ch.role?.newValue === 'host' && vs) vStop('已切回 host，連線已停止');
});
