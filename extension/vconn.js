// viewer 端 WebRTC（offscreen 頁面）：建立連線、組回畫面，以 blob URL 交給檢視頁面顯示。
// 畫面往這裡來；檢視頁面的滑鼠鍵盤事件經這裡送給 host（host 在 input() 逐項檢查後才執行）
// 每條連線一個物件 c，所有回呼只認「自己是不是目前這條」，被取代的連線不會再發任何訊息
let vc = null; // { id, pc, dc, frame, connected, dead }
let vlast = {}, vurls = []; // vlast：各類訊息最近一筆，檢視頁面晚開時補送
const vsend = (m, c = vc) => chrome.runtime.sendMessage({ target: 'sw', id: c?.id, ...m }).catch(() => {}); // 上行訊息一律帶連線編號
const vlog = (...a) => vsend({ type: 'log', line: '[viewer] ' + a.join(' ') });
const emit = (m) => {
  if (m.type !== 'same') vlast[m.type] = m;
  if (m.type === 'frame') delete vlast.error; // 新畫面取代舊的錯誤，反之亦然
  if (m.type === 'error') delete vlast.frame;
  chrome.runtime.sendMessage({ target: 'viewer', ...m }).catch(() => {});
};

function vstop() {
  const c = vc; vc = null; vlast = {};
  if (!c) return;
  c.pc.onconnectionstatechange = null; c.dc.onclose = null;
  c.pc.close();
}
function vdie(c) { // 連線結束的唯一出口，只通知一次
  if (c !== vc || c.dead) return;
  c.dead = true;
  vsend({ type: 'v-closed', connected: c.connected }, c);
}

async function vstart(id) {
  vstop();
  const p = new RTCPeerConnection({ iceServers: [] });
  const dc = p.createDataChannel('v');
  dc.binaryType = 'arraybuffer';
  const c = vc = { id, pc: p, dc, frame: null, connected: false, dead: false };
  dc.onmessage = (e) => onData(c, e);
  dc.onclose = () => vdie(c);
  p.onconnectionstatechange = () => {
    if (c !== vc) return;
    vlog('connection', p.connectionState);
    if (p.connectionState === 'connected') { c.connected = true; vsend({ type: 'v-connected' }, c); }
    if (['failed', 'closed'].includes(p.connectionState)) vdie(c);
  };
  await p.setLocalDescription(await p.createOffer());
  await gathered(p);
  if (c !== vc) return; // 等待期間已被新連線取代，不要送出失效的 offer
  const offer = keepTailscaleOnly(p.localDescription.sdp);
  vlog('offer 保留的 Tailscale candidate 數:', offer.kept);
  vsend({ type: 'v-offer', sdp: offer.sdp, kept: offer.kept }, c);
}

function onData(c, e) {
  if (c !== vc) return;
  if (typeof e.data !== 'string') {
    if (!c.frame) return;
    c.frame.parts.push(e.data);
    if (c.frame.parts.length >= c.frame.m.chunks) { showFrame(c.frame.m, c.frame.parts); c.frame = null; }
    return;
  }
  let m;
  try { m = JSON.parse(e.data); } catch { return; }
  if (m.type === 'h') c.frame = { m, parts: [] };
  if (m.type === 'same') emit({ type: 'same', state: m.state });
  if (m.type === 'error') emit({ type: 'error', message: m.message });
  if (m.type === 'end') emit({ type: 'end' });
  if (m.type === 'tabs' && Array.isArray(m.tabs)) emit({ type: 'tabs', cur: m.cur, pinned: m.pinned, tabs: m.tabs });
}

function showFrame(m, parts) {
  const src = URL.createObjectURL(new Blob(parts, { type: 'image/jpeg' }));
  vurls.push(src);
  if (vurls.length > 4) URL.revokeObjectURL(vurls.shift());
  emit({ type: 'frame', src, state: m.state, ts: m.ts, tabId: m.tabId });
}

chrome.runtime.onMessage.addListener((m) => {
  if (m.target !== 'voff') return;
  if (m.type === 'start') vstart(m.id).catch((e) => vlog('start 失敗:', e.message));
  if (m.type === 'answer' && vc && m.id === vc.id) vc.pc.setRemoteDescription({ type: 'answer', sdp: keepTailscaleOnly(m.sdp).sdp }).catch((e) => vlog('answer 失敗:', e.message));
  if (m.type === 'stop' && (!vc || m.id === vc.id)) vstop(); // 晚到的舊 stop 不能殺掉新連線
  if (m.type === 'input' && vc?.dc.readyState === 'open') vc.dc.send(JSON.stringify(m.ev));
  if (m.type === 'resend') Object.values(vlast).forEach(emit); // 檢視頁面是第一張畫面到了才開的，補送
});
