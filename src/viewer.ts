// 檢視頁面：顯示畫面，並把這裡的滑鼠鍵盤事件經 offscreen 送給 host。連線在 offscreen 跑，第一張畫面到了背景程式才開這個分頁
import type { Button, CtlEv, InputEv, Msg, PageEv, ViewBody, VoffMsg } from './protocol.ts';

type Tabs = Extract<ViewBody, { type: 'tabs' }>;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const toVoff = (m: VoffMsg) => chrome.runtime.sendMessage(m).catch(() => {});
chrome.runtime.connect({ name: 'viewer-page' }).onDisconnect.addListener(() => void chrome.runtime.lastError); // 生命線：這個頁面一關，viewer 的連線就停止
let curTab: number | null = null; // 目前畫面屬於 host 的哪個分頁；輸入要帶上它，host 發現已經換分頁就丟棄
let lastFrameAt = 0, mode = 'wait', minLat = Infinity, extraLat = 0, frameTimes: number[] = [];
const fps = () => { const now = Date.now(); frameTimes = frameTimes.filter((t) => now - t < 5000); return (frameTimes.length / 5).toFixed(1); };
const img = $<HTMLImageElement>('img'), vid = $<HTMLVideoElement>('vid'), kb = $<HTMLTextAreaElement>('kb'), addr = $<HTMLInputElement>('addr');
let view: 'img' | 'vid' = 'img'; // 目前畫面來自圖片還是視訊串流；滑鼠座標要對著目前顯示的那個換算
const surface = () => (view === 'vid' ? vid : img);
const surfaces: HTMLElement[] = [img, vid]; // 事件綁在兩個上；標成 HTMLElement 才拿得到 MouseEvent 型別
const isSurface = (t: EventTarget | null) => t === img || t === vid;

// 視訊串流在 offscreen 文件（viewer 的 RTCPeerConnection 在那裡），同源，直接取走它掛在 window 上的串流
function attachVideo() {
  const off = chrome.extension.getViews().find((w) => w.location.pathname === '/offscreen.html');
  const s = off?.cgStream;
  if (s && vid.srcObject !== s) { vid.srcObject = s; vid.play().catch(() => {}); }
}
// 視訊真的出了一張畫面才顯示它（硬體編碼器第一張可能要等一下；不能在收到訊息時就顯示，會黑畫面或閃舊畫面）。fps 也用這裡量，不用 DataChannel 的訊息量
const onVideoFrame = () => {
  vid.requestVideoFrameCallback(onVideoFrame);
  if (view !== 'vid') return;
  vid.hidden = false; img.hidden = true; $('msg').hidden = true;
  lastFrameAt = Date.now(); mode = 'frame'; frameTimes.push(lastFrameAt);
};
vid.requestVideoFrameCallback(onVideoFrame);

const setStatus = (t: unknown) => { $('status').textContent = typeof t === 'string' ? t : ''; };
chrome.storage.local.get('cg_status').then(({ cg_status }) => setStatus(cg_status));
chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.cg_status) setStatus(ch.cg_status.newValue); });

function onMsg(m: Msg) {
  if (m.target !== 'viewer') return;
  if (m.type === 'frame') {
    curTab = m.tabId;
    setLocked(false);
    if (m.src) {
      view = 'img';
      img.src = m.src; img.hidden = false; vid.hidden = true; $('msg').hidden = true;
      lastFrameAt = Date.now(); mode = 'frame';
      // 單程延遲含兩台時鐘誤差；減掉目前看過的最小值，剩下的就是排隊造成的額外延遲
      const lat = lastFrameAt - m.ts; minLat = Math.min(minLat, lat); extraLat = lat - minLat; frameTimes.push(lastFrameAt);
    } else { view = 'vid'; attachVideo(); } // 沒有 src：像素在視訊串流裡，顯示留給 onVideoFrame
  }
  if (m.type === 'same') mode = 'same';
  if (m.type === 'error') { mode = 'error'; img.hidden = true; vid.hidden = true; $('msg').hidden = false; $('msg').textContent = m.message; }
  if (m.type === 'end') { mode = 'end'; curTab = null; setLocked(true); }
  if (m.type === 'tabs') renderTabs(m);
  if (m.type === 'copied') navigator.clipboard.writeText(m.text).catch(() => {}); // host 選取的文字寫進這台的剪貼簿
}
chrome.runtime.onMessage.addListener(onMsg);
toVoff({ target: 'voff', type: 'resend' }); // 這個分頁是第一張畫面到了才開的，補收最近一筆

setInterval(() => {
  if (!lastFrameAt || mode === 'end') return;
  const s = Math.round((Date.now() - lastFrameAt) / 1000);
  $('age').textContent = mode === 'same' ? `畫面未變動（${s} 秒）` : `${s} 秒前更新（${view === 'vid' ? '視訊' : `延遲 +${extraLat}ms`}，${fps()} fps）`;
}, 500);

$('showlog').onclick = async () => {
  const { cg_log = [] } = await chrome.storage.local.get<{ cg_log: string[] }>('cg_log');
  $('log').textContent = cg_log.join('\n');
  $('log').hidden = !$('log').hidden;
};

// ---- 遠端操作：座標以 0 到 1 的比例傳，host 再換算成它自己的可視區 ----
const sendEv = (ev: InputEv) => toVoff({ target: 'voff', type: 'input', ev });
const sendInput = (ev: PageEv) => { if (curTab != null) sendEv({ ...ev, tabId: curTab }); };
const mods = (e: MouseEvent | KeyboardEvent) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
const BTN: Button[] = ['left', 'middle', 'right'];

function norm(e: MouseEvent) { // 扣掉 object-fit: contain 的留白
  const el = surface(), r = el.getBoundingClientRect();
  const nw = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth, nh = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight;
  if (!nw || !nh) return null;
  const k = Math.min(r.width / nw, r.height / nh), w = nw * k, h = nh * k;
  return { x: (e.clientX - r.left - (r.width - w) / 2) / w, y: (e.clientY - r.top - (r.height - h) / 2) / h };
}
type Pt = NonNullable<ReturnType<typeof norm>>;
const inside = (p: Pt | null): p is Pt => !!p && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;

let held: Button | null = null, lastMove = 0; // held：按住的按鈕，拖出圖片外也要收得到
for (const el of surfaces) el.addEventListener('mousedown', (e) => {
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
  if (!held && !isSurface(e.target)) return;
  const now = Date.now(); if (now - lastMove < 33) return;
  const p = norm(e); if (!p) return;
  lastMove = now;
  sendInput({ type: 'mouse', a: 'move', ...p, b: held || 'none', mod: mods(e) });
});
for (const el of surfaces) el.addEventListener('contextmenu', (e) => e.preventDefault());

let wheel: (Pt & { dx: number; dy: number; mod: number }) | null = null; // 觸控板慣性每秒上百筆，累加後每 33 ms 送一次
for (const el of surfaces) el.addEventListener('wheel', (e) => {
  e.preventDefault();
  const p = norm(e); if (!inside(p)) return;
  if (wheel) { wheel.dx += e.deltaX; wheel.dy += e.deltaY; Object.assign(wheel, p); return; }
  wheel = { ...p, dx: e.deltaX, dy: e.deltaY, mod: mods(e) };
  setTimeout(() => { if (wheel) sendInput({ type: 'mouse', a: 'wheel', ...wheel }); wheel = null; }, 33);
}, { passive: false });

// 鍵盤由透明的 textarea 接收（輸入法在圖片上不會啟動）
const keyEv = (a: 'down' | 'up', e: KeyboardEvent): PageEv => {
  const text = e.key === 'Enter' ? '\r' : e.key.length === 1 && !e.ctrlKey && !e.metaKey ? e.key : '';
  return { type: 'key', a, key: e.key, code: e.code, vk: e.keyCode, text: a === 'down' ? text : '', mod: mods(e) };
};
for (const a of ['down', 'up'] as const) kb.addEventListener(`key${a}`, (e) => {
  if (e.isComposing || e.keyCode === 229) return; // 組字中的按鍵留給輸入法
  const cmd = e.metaKey || e.ctrlKey;
  if (cmd && e.key === 'v') return; // 貼上走 paste 事件，送的是這台的剪貼簿
  if (a === 'down' && cmd && (e.key === 'c' || e.key === 'x')) sendInput({ type: 'copy' }); // 先讀 host 選取的文字（剪下要在它被剪掉之前）
  e.preventDefault(); sendInput(keyEv(a, e));
});
kb.addEventListener('compositionend', (e) => { if (e.data) sendInput({ type: 'text', text: e.data }); kb.value = ''; });
kb.addEventListener('paste', (e) => { // 長文字分段送：host 每筆訊息有長度上限，超過會被靜默丟掉；用 Array.from 切才不會切壞表情符號
  e.preventDefault();
  const chars = Array.from(e.clipboardData?.getData('text') ?? '');
  for (let i = 0; i < chars.length; i += 500) sendInput({ type: 'text', text: chars.slice(i, i + 500).join('') });
});

// ---- 網址列與分頁列：控制 host 的 Claude 群組分頁。host 才是真正的關口，這裡送的 tabId 不會被改寫 ----
const sendCtl = (ev: CtlEv) => sendEv(ev);
let info: Pick<Tabs, 'tabs' | 'cur' | 'pinned'> = { tabs: [], cur: null, pinned: false };
function setLocked(on: boolean) { $('ctl').inert = $('tabs').inert = on; } // AI 結束後停用

function renderTabs(m: Tabs) {
  info = m;
  const list = $('tablist');
  list.replaceChildren(...m.tabs.map((t) => {
    const el = document.createElement('div'), name = document.createElement('span'), x = document.createElement('span');
    el.className = 'tab' + (t.id === m.cur ? ' on' : ''); el.dataset.id = String(t.id);
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
  const t = e.target as HTMLElement;
  const el = t.closest<HTMLElement>('.tab');
  if (!el) return;
  e.preventDefault(); kb.focus();
  sendCtl({ type: 'tab', a: t.dataset.close ? 'close' : 'select', tabId: Number(el.dataset.id) });
});
const nav = (a: 'back' | 'forward' | 'reload') => info.cur != null && sendCtl({ type: 'nav', a, tabId: info.cur });
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
