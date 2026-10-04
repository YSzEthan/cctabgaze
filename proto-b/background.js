// 背景接收（headless）：被 storage.sync 事件叫醒 → 開 offscreen 頁面跑 WebRTC → 把 answer 寫回 sync
// 壓力測試：連線後每 500ms 產生一張 200KB 的假畫面（base64，模擬 debugger 截圖）交給 offscreen 送出
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
const toOffscreen = (m) => chrome.runtime.sendMessage({ target: 'offscreen', ...m }).catch(() => {});

chrome.storage.onChanged.addListener(async (ch, area) => {
  const o = area === 'sync' && ch.tg_offer && ch.tg_offer.newValue;
  if (!o) return;
  const { headless, deviceId } = await chrome.storage.local.get(['headless', 'deviceId']);
  if (!headless) return;
  if (o.from && o.from === deviceId) return; // 忽略自己寫的 offer
  const age = Date.now() - o.t;
  if (age > 90000) return slog('忽略過期的 offer，已過', age, 'ms');
  slog('背景程式被同步事件叫醒，收到 offer，延遲約', age, 'ms');
  try { const groups = await chrome.tabGroups.query({}); slog('分頁群組標題:', JSON.stringify(groups.map((g) => g.title))); }
  catch (e) { slog('讀取分頁群組失敗:', e.message); }
  await ensureOffscreen();
  for (let i = 0; i < 5; i++) {
    try { await chrome.runtime.sendMessage({ target: 'offscreen', type: 'offer', sdp: o.sdp }); return; }
    catch { await new Promise((r) => setTimeout(r, 300)); }
  }
  slog('offscreen 沒有回應');
});

let stressIv = null;
function makePayload() { // 200KB 隨機位元組（和 JPEG 一樣無法壓縮），轉成 base64
  const u = new Uint8Array(200000);
  for (let i = 0; i < u.length; i += 65536) crypto.getRandomValues(u.subarray(i, i + 65536));
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
function startStress() {
  clearInterval(stressIv);
  const b64 = makePayload(), start = Date.now();
  slog('壓力測試開始：每 500ms 一張 200KB，共 120 秒');
  stressIv = setInterval(() => {
    if (Date.now() - start > 120000) { clearInterval(stressIv); toOffscreen({ type: 'stress-end' }); return; }
    toOffscreen({ type: 'frame', b64, t: Date.now() });
  }, 500);
}

chrome.runtime.onMessage.addListener((m) => {
  if (m.target !== 'sw') return;
  if (m.type === 'log') slog('[offscreen]', m.line);
  if (m.type === 'answer') chrome.storage.sync.set({ tg_answer: { sdp: m.sdp, t: Date.now() } }).then(() => slog('answer 已寫入 sync'));
  if (m.type === 'stress-start') startStress();
  if (m.type === 'stress-stop') clearInterval(stressIv);
});
