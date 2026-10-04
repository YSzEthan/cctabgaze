// 檢視頁面：顯示畫面，並把這裡的滑鼠鍵盤事件經 offscreen 送給 host。連線在 offscreen 跑，第一張畫面到了背景程式才開這個分頁
const $ = (id) => document.getElementById(id);
let curTab = null; // 目前畫面屬於 host 的哪個分頁；輸入要帶上它，host 發現已經換分頁就丟棄
let lastFrameAt = 0, mode = 'wait', minLat = Infinity, extraLat = 0, frameTimes = [];
const fps = () => { const now = Date.now(); frameTimes = frameTimes.filter((t) => now - t < 5000); return (frameTimes.length / 5).toFixed(1); };

const setStatus = (t) => { $('status').textContent = t || ''; };
chrome.storage.local.get('cg_status').then(({ cg_status }) => setStatus(cg_status));
chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.cg_status) setStatus(ch.cg_status.newValue); });

function onMsg(m) {
  if (m.target !== 'viewer') return;
  if (m.type === 'frame') {
    $('img').src = m.src; $('img').hidden = false; $('msg').hidden = true;
    curTab = m.tabId;
    setLocked(false);
    lastFrameAt = Date.now(); mode = 'frame';
    // 單程延遲含兩台時鐘誤差；減掉目前看過的最小值，剩下的就是排隊造成的額外延遲
    const lat = lastFrameAt - m.ts; minLat = Math.min(minLat, lat); extraLat = lat - minLat; frameTimes.push(lastFrameAt);
  }
  if (m.type === 'same') mode = 'same';
  if (m.type === 'error') { mode = 'error'; $('img').hidden = true; $('msg').hidden = false; $('msg').textContent = m.message; }
  if (m.type === 'end') { mode = 'end'; curTab = null; setLocked(true); }
  if (m.type === 'tabs') renderTabs(m);
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

// ---- 遠端操作：座標以 0 到 1 的比例傳，host 再換算成它自己的可視區 ----
const img = $('img'), kb = $('kb');
const sendInput = (ev) => { if (curTab != null) chrome.runtime.sendMessage({ target: 'voff', type: 'input', ev: { ...ev, tabId: curTab } }).catch(() => {}); };
const mods = (e) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
const BTN = ['left', 'middle', 'right'];

function norm(e) { // 扣掉 object-fit: contain 的留白
  const r = img.getBoundingClientRect(), nw = img.naturalWidth, nh = img.naturalHeight;
  if (!nw || !nh) return null;
  const k = Math.min(r.width / nw, r.height / nh), w = nw * k, h = nh * k;
  return { x: (e.clientX - r.left - (r.width - w) / 2) / w, y: (e.clientY - r.top - (r.height - h) / 2) / h };
}
const inside = (p) => p && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;

let held = null, lastMove = 0; // held：按住的按鈕，拖出圖片外也要收得到
img.addEventListener('mousedown', (e) => {
  const p = norm(e); if (!inside(p)) return;
  e.preventDefault(); kb.focus();
  held = BTN[e.button] || 'left';
  sendInput({ type: 'mouse', a: 'down', ...p, b: held, n: e.detail || 1, mod: mods(e) });
});
addEventListener('mouseup', (e) => {
  if (!held) return;
  const p = norm(e); if (p) sendInput({ type: 'mouse', a: 'up', ...p, b: held, n: e.detail || 1, mod: mods(e) });
  held = null;
});
addEventListener('mousemove', (e) => {
  if (!held && e.target !== img) return;
  const now = Date.now(); if (now - lastMove < 33) return;
  const p = norm(e); if (!p) return;
  lastMove = now;
  sendInput({ type: 'mouse', a: 'move', ...p, b: held || 'none', mod: mods(e) });
});
img.addEventListener('contextmenu', (e) => e.preventDefault());

let wheel = null; // 觸控板慣性每秒上百筆，累加後每 33 ms 送一次
img.addEventListener('wheel', (e) => {
  e.preventDefault();
  const p = norm(e); if (!inside(p)) return;
  if (wheel) { wheel.dx += e.deltaX; wheel.dy += e.deltaY; Object.assign(wheel, p); return; }
  wheel = { ...p, dx: e.deltaX, dy: e.deltaY, mod: mods(e) };
  setTimeout(() => { sendInput({ type: 'mouse', a: 'wheel', ...wheel }); wheel = null; }, 33);
}, { passive: false });

// 鍵盤由透明的 textarea 接收（輸入法在圖片上不會啟動）
const keyEv = (a, e) => {
  const text = e.key === 'Enter' ? '\r' : e.key.length === 1 && !e.ctrlKey && !e.metaKey ? e.key : '';
  return { type: 'key', a, key: e.key, code: e.code, vk: e.keyCode, text: a === 'down' ? text : '', mod: mods(e) };
};
for (const a of ['down', 'up']) kb.addEventListener('key' + a, (e) => {
  if (e.isComposing || e.keyCode === 229) return; // 組字中的按鍵留給輸入法
  if (e.metaKey && e.key === 'v') return; // 貼上走 paste 事件，送的是這台的剪貼簿
  e.preventDefault(); sendInput(keyEv(a, e));
});
kb.addEventListener('compositionend', (e) => { if (e.data) sendInput({ type: 'text', text: e.data }); kb.value = ''; });
kb.addEventListener('paste', (e) => { e.preventDefault(); const t = e.clipboardData.getData('text'); if (t) sendInput({ type: 'text', text: t }); });

// ---- 網址列與分頁列：控制 host 的 Claude 群組分頁。host 才是真正的關口，這裡送的 tabId 不會被改寫 ----
const sendCtl = (ev) => chrome.runtime.sendMessage({ target: 'voff', type: 'input', ev }).catch(() => {});
const addr = $('addr');
let info = { tabs: [], cur: null, pinned: false };
const setLocked = (on) => { $('ctl').inert = $('tabs').inert = on; }; // AI 結束後停用

function renderTabs(m) {
  info = m;
  const list = $('tablist');
  list.replaceChildren(...m.tabs.map((t) => {
    const el = document.createElement('div'), name = document.createElement('span'), x = document.createElement('span');
    el.className = 'tab' + (t.id === m.cur ? ' on' : ''); el.dataset.id = t.id;
    name.className = 'name'; name.textContent = t.title || t.url || '(無標題)'; name.title = t.url;
    x.className = 'x'; x.textContent = '×'; x.dataset.close = '1';
    el.append(name, x);
    return el;
  }));
  list.querySelector('.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  $('auto').hidden = !m.pinned;
  const cur = m.tabs.find((t) => t.id === m.cur);
  document.title = (cur?.title || 'cctabgaze');
  if (document.activeElement !== addr) addr.value = cur?.url || ''; // 使用者正在輸入時不蓋掉
}

// 按鈕不拿走焦點，按完上一頁還能直接打字；分頁列在 mousedown 處理（標題一變整列重繪，click 會被吃掉）
for (const b of document.querySelectorAll('button')) b.addEventListener('mousedown', (e) => e.preventDefault());
$('tablist').addEventListener('mousedown', (e) => {
  const el = e.target.closest('.tab');
  if (!el) return;
  e.preventDefault(); kb.focus();
  sendCtl({ type: 'tab', a: e.target.dataset.close ? 'close' : 'select', tabId: Number(el.dataset.id) });
});
const nav = (a) => info.cur != null && sendCtl({ type: 'nav', a, tabId: info.cur });
$('back').onclick = () => nav('back');
$('fwd').onclick = () => nav('forward');
$('reload').onclick = () => nav('reload');
$('newtab').onclick = () => sendCtl({ type: 'tab', a: 'open' });
$('auto').onclick = () => sendCtl({ type: 'tab', a: 'auto' });
addr.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return; // 注音選字的 Enter 不送出
  if (e.key === 'Enter') { if (info.cur != null) sendCtl({ type: 'nav', a: 'go', url: addr.value, tabId: info.cur }); kb.focus(); }
  if (e.key === 'Escape') { addr.value = info.tabs.find((t) => t.id === info.cur)?.url || ''; kb.focus(); }
});
