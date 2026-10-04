// 檢視頁面：只負責顯示。連線在 offscreen 跑，第一張畫面到了背景程式才開這個分頁
const $ = (id) => document.getElementById(id);
let lastFrameAt = 0, mode = 'wait', minLat = Infinity, extraLat = 0, frameTimes = [];
const fps = () => { const now = Date.now(); frameTimes = frameTimes.filter((t) => now - t < 5000); return (frameTimes.length / 5).toFixed(1); };

const setStatus = (t) => { $('status').textContent = t || ''; };
chrome.storage.local.get('cg_status').then(({ cg_status }) => setStatus(cg_status));
chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.cg_status) setStatus(ch.cg_status.newValue); });

function onMsg(m) {
  if (m.target !== 'viewer') return;
  if (m.type === 'frame') {
    $('img').src = m.src; $('img').hidden = false; $('msg').hidden = true;
    $('title').textContent = m.title; $('url').textContent = m.url;
    lastFrameAt = Date.now(); mode = 'frame';
    // 單程延遲含兩台時鐘誤差；減掉目前看過的最小值，剩下的就是排隊造成的額外延遲
    const lat = lastFrameAt - m.ts; minLat = Math.min(minLat, lat); extraLat = lat - minLat; frameTimes.push(lastFrameAt);
  }
  if (m.type === 'same') mode = 'same';
  if (m.type === 'error') { mode = 'error'; $('img').hidden = true; $('msg').hidden = false; $('msg').textContent = m.message; $('title').textContent = '無法顯示'; $('url').textContent = ''; }
  if (m.type === 'end') mode = 'end';
}
chrome.runtime.onMessage.addListener(onMsg);
chrome.runtime.sendMessage({ target: 'voff', type: 'resend' }).catch(() => {}); // 這個分頁是第一張畫面到了才開的，補收最近一筆

setInterval(() => {
  if (!lastFrameAt || mode === 'end') return;
  const s = Math.round((Date.now() - lastFrameAt) / 1000);
  $('age').textContent = mode === 'same' ? `畫面未變動（${s} 秒）` : `${s} 秒前更新（延遲 +${extraLat}ms，${fps()} fps）`;
}, 500);

$('showlog').onclick = async () => {
  const { cg_log = [] } = await chrome.storage.local.get('cg_log');
  $('log').textContent = cg_log.join('\n');
  $('log').hidden = !$('log').hidden;
};
