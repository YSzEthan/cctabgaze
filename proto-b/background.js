// 背景接收（headless viewer）：被 storage.sync 事件叫醒 → 開 offscreen 頁面跑 WebRTC → 把 answer 寫回 sync
chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: chrome.runtime.getURL('panel.html') }));

let q = Promise.resolve();
const slog = (...a) => { q = q.then(async () => {
  const line = `[${new Date().toISOString().slice(11, 23)}] ` + a.join(' ');
  const { tg_log = [] } = await chrome.storage.local.get('tg_log');
  tg_log.push(line);
  await chrome.storage.local.set({ tg_log: tg_log.slice(-300) });
}); return q; };

async function ensureOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (!ctx.length) await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['WEB_RTC'], justification: '與遠端 Chrome 建立 WebRTC 連線接收畫面' });
}

chrome.storage.onChanged.addListener(async (ch, area) => {
  const o = area === 'sync' && ch.tg_offer && ch.tg_offer.newValue;
  if (!o) return;
  const { headless } = await chrome.storage.local.get('headless');
  if (!headless) return;
  const { deviceId } = await chrome.storage.local.get('deviceId');
  if (o.from && o.from === deviceId) return; // 忽略自己寫的 offer
  const age = Date.now() - o.t;
  if (age > 90000) return slog('忽略過期的 offer，已過', age, 'ms');
  slog('背景程式被同步事件叫醒，收到 offer，延遲約', age, 'ms');
  await ensureOffscreen();
  for (let i = 0; i < 5; i++) {
    try { await chrome.runtime.sendMessage({ target: 'offscreen', type: 'offer', sdp: o.sdp }); return; }
    catch { await new Promise((r) => setTimeout(r, 300)); }
  }
  slog('offscreen 沒有回應');
});

chrome.runtime.onMessage.addListener((m) => {
  if (m.target !== 'sw') return;
  if (m.type === 'log') slog('[offscreen]', m.line);
  if (m.type === 'answer') chrome.storage.sync.set({ tg_answer: { sdp: m.sdp, t: Date.now() } }).then(() => slog('answer 已寫入 sync'));
});
