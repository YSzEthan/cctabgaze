// viewer 端 WebRTC（offscreen 頁面）：建立連線、組回畫面，以 blob URL 交給檢視頁面顯示。
// 畫面往這裡來；檢視頁面的滑鼠鍵盤事件經這裡送給 host（host 在 input() 逐項檢查後才執行）
// 每條連線一個物件 c，所有回呼只認「自己是不是目前這條」，被取代的連線不會再發任何訊息
const RX_TIMEOUT = 10000; // host 最慢約 5 秒必有一筆資料（畫面或 same）；10 秒沒收到視為中斷
let vc = null; // { id, pc, dc, frame, connected, dead, lastRx, watch, nets, verified, queue }
const pagePorts = new Set(); // 檢視頁面各開一條 port 當生命線，全部斷了就停止連線
let pageSeen = false;
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
  clearInterval(c.watch);
  c.pc.onconnectionstatechange = null; c.dc.onclose = null;
  c.pc.close();
  idleCheck();
}
function vdie(c) { // 連線結束的唯一出口，只通知一次
  if (c !== vc || c.dead) return;
  c.dead = true;
  clearInterval(c.watch);
  vsend({ type: 'v-closed', connected: c.connected }, c);
}

// 連上後檢查實際選用的兩端位址；通過才通知背景程式「已連線」並處理 host 的資料（驗證前收到的先排隊）
async function vverify(c) {
  const r = await checkPair(c.pc, c.nets);
  if (c !== vc || c.dead) return;
  vlog('選用 pair:', r.local, '→', r.remote, r.ok ? '' : '（不在允許網段內，關閉連線）');
  if (!r.ok) { c.dead = true; clearInterval(c.watch); vsend({ type: 'v-netfail', detail: r.local ? `${r.local} → ${r.remote}` : '讀不到實際使用的位址' }, c); return; }
  if (c.verified) return; // 選用的 pair 之後換了而重查：通過就維持現狀
  c.verified = true;
  vsend({ type: 'v-connected' }, c);
  c.queue.splice(0).forEach((e) => onData(c, e));
}

async function vstart(id, rawNets) {
  vstop();
  const p = new RTCPeerConnection({ iceServers: [] });
  const dc = p.createDataChannel('v');
  dc.binaryType = 'arraybuffer';
  const c = vc = { id, pc: p, dc, frame: null, connected: false, dead: false, lastRx: Date.now(), watch: null, nets: netsOrDefault(rawNets), verified: false, queue: [] };
  pageSeen = pagePorts.size > 0;
  dc.onmessage = (e) => onData(c, e);
  dc.onclose = () => vdie(c);
  p.onconnectionstatechange = () => {
    if (c !== vc) return;
    vlog('connection', p.connectionState);
    if (p.connectionState === 'connected') {
      c.connected = true; c.lastRx = Date.now();
      c.watch = setInterval(() => { if (Date.now() - c.lastRx > RX_TIMEOUT) { vlog('超過', RX_TIMEOUT / 1000, '秒沒收到資料，視為中斷'); vdie(c); } }, 2000);
      if (!c.pairWatched) { c.pairWatched = true; p.sctp?.transport?.iceTransport?.addEventListener('selectedcandidatepairchange', () => vverify(c)); }
      vverify(c);
    }
    if (['failed', 'closed'].includes(p.connectionState)) vdie(c);
  };
  await p.setLocalDescription(await p.createOffer());
  await gathered(p);
  if (c !== vc) return; // 等待期間已被新連線取代，不要送出失效的 offer
  const offer = keepAllowed(p.localDescription.sdp, c.nets);
  vlog('offer 保留的允許網段 candidate 數:', offer.kept);
  vsend({ type: 'v-offer', sdp: offer.sdp, kept: offer.kept }, c);
}

function onData(c, e) {
  if (c !== vc) return;
  c.lastRx = Date.now();
  if (!c.verified) { c.queue.push(e); return; } // 還沒確認對方位址在允許網段內，先不處理
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
  if (m.type === 'end') { clearInterval(c.watch); emit({ type: 'end', reason: m.reason }); } // host 有意結束，不再算沉默
  if (m.type === 'tabs' && Array.isArray(m.tabs)) emit({ type: 'tabs', cur: m.cur, pinned: m.pinned, tabs: m.tabs });
}

function showFrame(m, parts) {
  const src = URL.createObjectURL(new Blob(parts, { type: 'image/jpeg' }));
  vurls.push(src);
  if (vurls.length > 4) URL.revokeObjectURL(vurls.shift());
  emit({ type: 'frame', src, state: m.state, ts: m.ts, tabId: m.tabId });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'viewer-page') return;
  pagePorts.add(port); pageSeen = true;
  port.onDisconnect.addListener(() => {
    pagePorts.delete(port);
    if (pageSeen && !pagePorts.size && vc) vsend({ type: 'v-pagegone' }); // 檢視頁面關了、或被導去別的網址
  });
});

chrome.runtime.onMessage.addListener((m) => {
  if (m.target !== 'voff') return;
  if (m.type === 'start') vstart(m.id, m.nets).catch((e) => vlog('start 失敗:', e.message));
  if (m.type === 'answer' && vc && m.id === vc.id) {
    const ans = keepAllowed(m.sdp, vc.nets);
    if (!ans.kept) { vsend({ type: 'v-netfail', detail: 'host 提供的位址都不在允許網段內' }); return; }
    vc.pc.setRemoteDescription({ type: 'answer', sdp: ans.sdp }).catch((e) => vlog('answer 失敗:', e.message));
  }
  if (m.type === 'stop' && (!vc || m.id === vc.id)) vstop(); // 晚到的舊 stop 不能殺掉新連線
  if (m.type === 'input' && vc?.verified && vc.dc.readyState === 'open') vc.dc.send(JSON.stringify(m.ev));
  if (m.type === 'resend') Object.values(vlast).forEach(emit); // 檢視頁面是第一張畫面到了才開的，補送
});
