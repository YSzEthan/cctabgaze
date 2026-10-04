// cctabgaze 插件：只呼叫 chrome.debugger 的 getTargets / attach / detach / sendCommand('Page.captureScreenshot')
const RELAY = 'ws://127.0.0.1:17817/ext';
const INTERVAL_MS = 500;
const TIMEOUT_MS = 5000;

let ws = null;
let viewers = 0;
let attachedTabId = null;
let running = false;
let lastData = null;

const send = (obj) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  ws = new WebSocket(RELAY);
  ws.onopen = () => { ws._ping = setInterval(() => send({ type: 'ping' }), 20000); };
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m && m.type === 'viewers' && Number.isInteger(m.n)) setViewers(m.n);
  };
  ws.onclose = () => { clearInterval(ws._ping); setViewers(0); };
  ws.onerror = () => {};
}

function setViewers(n) {
  viewers = n;
  if (n > 0 && !running) loop();
  if (n === 0) release();
}

async function release() {
  if (attachedTabId !== null) {
    const t = attachedTabId; attachedTabId = null; lastData = null;
    try { await chrome.debugger.detach({ tabId: t }); } catch {}
  }
}

// 活動時間：分頁載入、更新或被切到前景時記錄，用來在多個 AI 分頁間穩定選擇（避免來回跳）
const activity = new Map();
const touch = (tabId) => activity.set(tabId, Date.now());
chrome.tabs.onUpdated.addListener((tabId) => touch(tabId));
chrome.tabs.onActivated.addListener(({ tabId }) => touch(tabId));
chrome.tabs.onRemoved.addListener((tabId) => activity.delete(tabId));

// AI 的分頁 = 已被別的偵錯者接上的分頁中，最近有活動的那個；目前接上的分頁沒有更新的活動就不換。
// 都找不到就退回最近使用過的一般網頁分頁
async function pickTarget() {
  const targets = await chrome.debugger.getTargets();
  const others = targets.filter((t) => t.type === 'page' && t.attached && t.tabId && t.tabId !== attachedTabId);
  let best = attachedTabId;
  let bestAt = attachedTabId === null ? -1 : activity.get(attachedTabId) || 0;
  for (const t of others) {
    const at = activity.get(t.tabId) || 0;
    if (best === null || at > bestAt) { best = t.tabId; bestAt = at; }
  }
  if (best !== null) return best;
  // 沒有任何偵錯者接著的分頁（AI 閒置）：選最近使用過的 http/https 分頁，排除檢視頁自己
  const tabs = await chrome.tabs.query({});
  let pick = null, pickAt = -1;
  for (const t of tabs) {
    if (!/^https?:/.test(t.url || '') || /^https?:\/\/(localhost|127\.0\.0\.1):17817\//.test(t.url)) continue;
    const at = Math.max(t.lastAccessed || 0, activity.get(t.id) || 0);
    if (at > pickAt) { pick = t.id; pickAt = at; }
  }
  return pick;
}

async function shot(tabId) {
  const res = await Promise.race([
    chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', { format: 'jpeg', quality: 50 }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('截圖逾時')), TIMEOUT_MS)),
  ]);
  return res.data;
}

async function loop() {
  running = true;
  while (viewers > 0) {
    try {
      const tabId = await pickTarget();
      if (tabId === null) { send({ type: 'error', message: '找不到可截圖的分頁' }); }
      else {
        if (tabId !== attachedTabId) {
          await release();
          try { await chrome.debugger.attach({ tabId }, '1.3'); attachedTabId = tabId; }
          catch (e) { send({ type: 'error', message: '無法接上分頁：' + e.message }); }
        }
        if (attachedTabId === tabId) {
          const tab = await chrome.tabs.get(tabId);
          const data = await shot(tabId);
          if (data === lastData) send({ type: 'same', ts: Date.now() });
          else { lastData = data; send({ type: 'frame', tabId, title: tab.title || '', url: tab.url || '', ts: Date.now(), data }); }
        }
      }
    } catch (e) {
      send({ type: 'error', message: String(e.message || e) });
      await release();
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
  running = false;
}

chrome.debugger.onDetach.addListener((src) => { if (src.tabId === attachedTabId) { attachedTabId = null; lastData = null; } });
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
