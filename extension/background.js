// cctabgaze host：被動待命。viewer 寫入 cg_req → 這裡被同步事件叫醒 → 有 Claude 分頁群組才回應
// 整份程式只呼叫 chrome.debugger 的 attach / detach / sendCommand('Page.captureScreenshot')
const REQ = 'cg_req', RES = 'cg_res';
const MIN_INTERVAL = 500, FAST_INTERVAL = 100, FALLBACK = 3000, SHOT_TIMEOUT = 5000, REQ_TTL = 60000;
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

async function pickTab(groups) {
  let best = null, bestAt = -1;
  for (const g of groups) {
    for (const t of await chrome.tabs.query({ groupId: g.id })) {
      if (!/^https?:/.test(t.url || '')) continue;
      const at = Math.max(t.lastAccessed || 0, activity.get(t.id) || 0);
      if (at > bestAt) { best = t; bestAt = at; }
    }
  }
  return best;
}

// ---- 連線階段 ----
let session = null; // { req, attachedTabId, lastData, lastStepAt }
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
    const tab = await pickTab(groups);
    if (!tab) toOff({ type: 'ctl', msg: { type: 'error', message: 'Claude 分頁群組裡沒有可截圖的網頁分頁' } });
    else {
      if (s.attachedTabId !== tab.id) { await release(); await chrome.debugger.attach({ tabId: tab.id }, '1.3'); s.attachedTabId = tab.id; }
      const state = stateOf((groups.find((g) => g.id === tab.groupId) || groups[0]).title);
      const data = await shot(tab.id);
      if (session !== s) return;
      if (data === s.lastData) toOff({ type: 'ctl', msg: { type: 'same', state } });
      else { s.lastData = data; sentFrame = true; toOff({ type: 'frame', b64: data, title: tab.title || '', url: tab.url || '', state, tabId: tab.id, ts: Date.now() }); }
    }
  } catch (e) {
    toOff({ type: 'ctl', msg: { type: 'error', message: String(e.message || e) } });
    await release();
  }
  if (session === s) schedule(sentFrame ? FALLBACK : MIN_INTERVAL); // 送了畫面就等 offscreen 回報「送完了」，再只等 FAST_INTERVAL
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
  session = { req, attachedTabId: null, lastData: null, lastStepAt: 0 };
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
  if (m.type === 'answer' && session && m.id === session.req.id) reply(session.req, { sdp: m.sdp }).then(() => slog('answer 已寫入 sync'));
  if (m.type === 'open' && session) { slog('DataChannel 開啟，開始傳畫面'); schedule(0); }
  if (m.type === 'ready' && session) schedule(fastGap(session)); // ready 只會在送出畫面後出現
  if (m.type === 'closed') endSession('viewer-left');
});

importScripts('viewer-bg.js');
