// viewer 端 WebRTC（offscreen 頁面）：建立連線、組回畫面，以 blob URL 交給檢視頁面顯示。
// 畫面往這裡來；檢視頁面的滑鼠鍵盤事件經這裡送給 host（host 在 input() 逐項檢查後才執行）
const vsend = (m) => chrome.runtime.sendMessage({ target: 'sw', ...m }).catch(() => {});
const vlog = (...a) => vsend({ type: 'log', line: '[viewer] ' + a.join(' ') });
const emit = (m) => { vlast = m; chrome.runtime.sendMessage({ target: 'viewer', ...m }).catch(() => {}); };
let vpc = null, vdc = null, vcur = null, vlast = null, vurls = [];

function vstop() {
  const p = vpc; vpc = null; vdc = null; vcur = null;
  if (p) { p.onconnectionstatechange = null; p.close(); }
}

async function vstart() {
  vstop();
  const p = vpc = new RTCPeerConnection({ iceServers: [] });
  const dc = p.createDataChannel('v');
  dc.binaryType = 'arraybuffer';
  vdc = dc;
  dc.onmessage = onData;
  let connected = false;
  p.onconnectionstatechange = () => {
    vlog('connection', p.connectionState);
    if (p.connectionState === 'connected') { connected = true; vsend({ type: 'v-connected' }); }
    if (['failed', 'closed'].includes(p.connectionState)) vsend({ type: 'v-closed', connected });
  };
  await p.setLocalDescription(await p.createOffer());
  await gathered(p);
  const offer = keepTailscaleOnly(p.localDescription.sdp);
  vlog('offer 保留的 Tailscale candidate 數:', offer.kept);
  vsend({ type: 'v-offer', sdp: offer.sdp, kept: offer.kept });
}

function onData(e) {
  if (typeof e.data !== 'string') {
    if (!vcur) return;
    vcur.parts.push(e.data);
    if (vcur.parts.length >= vcur.m.chunks) { showFrame(vcur.m, vcur.parts); vcur = null; }
    return;
  }
  const m = JSON.parse(e.data);
  if (m.type === 'h') vcur = { m, parts: [] };
  if (m.type === 'same') emit({ type: 'same', state: m.state });
  if (m.type === 'error') emit({ type: 'error', message: m.message });
  if (m.type === 'end') emit({ type: 'end' });
}

function showFrame(m, parts) {
  const src = URL.createObjectURL(new Blob(parts, { type: 'image/jpeg' }));
  vurls.push(src);
  if (vurls.length > 4) URL.revokeObjectURL(vurls.shift());
  emit({ type: 'frame', src, title: m.title, url: m.url, state: m.state, ts: m.ts, tabId: m.tabId });
}

chrome.runtime.onMessage.addListener((m) => {
  if (m.target !== 'voff') return;
  if (m.type === 'start') vstart().catch((e) => vlog('start 失敗:', e.message));
  if (m.type === 'answer' && vpc) vpc.setRemoteDescription({ type: 'answer', sdp: keepTailscaleOnly(m.sdp).sdp }).catch((e) => vlog('answer 失敗:', e.message));
  if (m.type === 'stop') vstop();
  if (m.type === 'input' && vdc?.readyState === 'open') vdc.send(JSON.stringify(m.ev));
  if (m.type === 'resend' && vlast) emit(vlast); // 檢視頁面是第一張畫面到了才開的，補送最近一筆
});
