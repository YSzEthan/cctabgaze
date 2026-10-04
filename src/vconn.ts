// viewer 端 WebRTC（offscreen 頁面）：建立連線、組回畫面，以 blob URL 交給檢視頁面顯示。
// 畫面往這裡來；檢視頁面的滑鼠鍵盤事件經這裡送給 host（host 在 input() 逐項檢查後才執行）
// 每條連線一個物件 c，所有回呼只認「自己是不是目前這條」，被取代的連線不會再發任何訊息
import { checkPair, gathered, keepAllowed, netsOrDefault, type Net } from './rtc.ts';
import { idleCheck, keepsAlive } from './idle.ts';
import type { FrameHead, HostWire, Msg, ViewBody, ViewerUp } from './protocol.ts';

interface VConn {
  id: string;
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  frame: { m: FrameHead; parts: ArrayBuffer[] } | null;
  connected: boolean;
  dead: boolean;
  lastRx: number;
  watch: ReturnType<typeof setInterval> | undefined;
  nets: Net[];
  verified: boolean;
  queue: MessageEvent[];
  pairWatched: boolean;
  vtr: RTCRtpTransceiver | null; // 視訊 transceiver；沒有 H264 時是 null，只走圖片
}

const RX_TIMEOUT = 10000; // host 最慢約 5 秒必有一筆資料（畫面或 same）；10 秒沒收到視為中斷
let vc: VConn | null = null;
keepsAlive(() => !!vc);
const pagePorts = new Set<chrome.runtime.Port>(); // 檢視頁面各開一條 port 當生命線，全部斷了就停止連線
let pageSeen = false;
let vlast: Partial<Record<ViewBody['type'], ViewBody>> = {}, vurls: string[] = []; // vlast：各類訊息最近一筆，檢視頁面晚開時補送
const vsend = (m: ViewerUp, c: VConn | null = vc) => chrome.runtime.sendMessage({ target: 'sw', id: c?.id, ...m }).catch(() => {}); // 上行訊息一律帶連線編號
const vlog = (...a: unknown[]) => vsend({ type: 'log', line: '[viewer] ' + a.join(' ') });
const emit = (m: ViewBody) => {
  if (m.type !== 'same' && m.type !== 'copied') vlast[m.type] = m; // copied 是一次性的，晚開的檢視頁不能再複製一次
  if (m.type === 'frame') delete vlast.error; // 新畫面取代舊的錯誤，反之亦然
  if (m.type === 'error') delete vlast.frame;
  chrome.runtime.sendMessage({ target: 'viewer', ...m }).catch(() => {});
};

function vstop() {
  const c = vc; vc = null; vlast = {};
  if (!c) return;
  clearInterval(c.watch);
  c.pc.onconnectionstatechange = null; c.dc.onclose = null;
  window.cgStream = undefined;
  c.pc.close();
  idleCheck();
}
function vdie(c: VConn) { // 連線結束的唯一出口，只通知一次
  if (c !== vc || c.dead) return;
  c.dead = true;
  clearInterval(c.watch);
  vsend({ type: 'v-closed', connected: c.connected }, c);
}

function netFail(c: VConn, detail: string) {
  c.dead = true;
  clearInterval(c.watch);
  vsend({ type: 'v-netfail', detail }, c);
}

// 連上後檢查實際選用的兩端位址；通過才通知背景程式「已連線」並處理 host 的資料（驗證前收到的先排隊）
async function vverify(c: VConn) {
  const r = await checkPair(c.pc, c.nets);
  if (c !== vc || c.dead) return;
  vlog('選用 pair:', r.local, '→', r.remote, r.ok ? '' : '（不在允許網段內，關閉連線）');
  if (!r.ok) return netFail(c, r.local ? `${r.local} → ${r.remote}` : '讀不到實際使用的位址');
  if (c.vtr && c.vtr.receiver.transport !== c.pc.sctp?.transport) return netFail(c, '視訊與資料不在同一條連線'); // 視訊若不和 DataChannel 同一條連線，位址檢查就沒涵蓋它
  if (c.verified) return; // 選用的 pair 之後換了而重查：通過就維持現狀
  c.verified = true;
  vsend({ type: 'v-connected' }, c);
  c.queue.splice(0).forEach((e) => onData(c, e));
}

// 只要硬體編碼的那幾組 H264（packetization-mode=1）：其他參數會掉到軟體 OpenH264，慢一半。瀏覽器沒有就不要視訊
function addVideo(p: RTCPeerConnection) {
  const ok = (k: RTCRtpCodec) => k.mimeType === 'video/rtx' || (k.mimeType === 'video/H264' && /packetization-mode=1/.test(k.sdpFmtpLine ?? '') && /profile-level-id=(64|4d|42)001f/.test(k.sdpFmtpLine ?? ''));
  const codecs = RTCRtpReceiver.getCapabilities('video')?.codecs.filter(ok) ?? [];
  if (!codecs.some((k) => k.mimeType === 'video/H264')) return null;
  const tr = p.addTransceiver('video', { direction: 'recvonly' });
  tr.setCodecPreferences(codecs);
  try { (tr.receiver as RTCRtpReceiver & { jitterBufferTarget: number | null }).jitterBufferTarget = 0; } catch {}
  return tr;
}

async function vstart(id: string, rawNets: unknown) {
  vstop();
  const p = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
  const dc = p.createDataChannel('v');
  dc.binaryType = 'arraybuffer';
  const c: VConn = vc = { id, pc: p, dc, frame: null, connected: false, dead: false, lastRx: Date.now(), watch: undefined, nets: netsOrDefault(rawNets), verified: false, queue: [], pairWatched: false, vtr: null };
  c.vtr = addVideo(p);
  p.ontrack = (e) => { if (c === vc && e.track.kind === 'video') window.cgStream = new MediaStream([e.track]); }; // 檢視頁用 getViews() 取走
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
  const offer = keepAllowed(p.localDescription?.sdp ?? '', c.nets);
  vlog('offer 保留的允許網段 candidate 數:', offer.kept);
  vsend({ type: 'v-offer', sdp: offer.sdp, kept: offer.kept }, c);
}

function onData(c: VConn, e: MessageEvent) {
  if (c !== vc) return;
  c.lastRx = Date.now();
  if (!c.verified) { c.queue.push(e); return; } // 還沒確認對方位址在允許網段內，先不處理
  if (typeof e.data !== 'string') {
    if (!c.frame) return;
    c.frame.parts.push(e.data);
    if (c.frame.parts.length >= c.frame.m.chunks) { showFrame(c.frame.m, c.frame.parts); c.frame = null; }
    return;
  }
  let m: HostWire;
  try { m = JSON.parse(e.data); } catch { return; }
  if (m.type === 'h') c.frame = { m, parts: [] };
  if (m.type === 'v') emit({ type: 'frame', state: m.state, ts: m.ts, tabId: m.tabId }); // 沒有 src：檢視頁從視訊串流顯示
  if (m.type === 'same') emit({ type: 'same', state: m.state });
  if (m.type === 'error') emit({ type: 'error', message: m.message });
  if (m.type === 'end') { clearInterval(c.watch); emit({ type: 'end', reason: m.reason }); } // host 有意結束，不再算沉默
  if (m.type === 'copied' && typeof m.text === 'string') emit({ type: 'copied', text: m.text });
  if (m.type === 'tabs' && Array.isArray(m.tabs)) emit({ type: 'tabs', cur: m.cur, pinned: m.pinned, tabs: m.tabs });
}

const MIME: Record<string, string> = { jpeg: 'image/jpeg', webp: 'image/webp', png: 'image/png' };
function showFrame(m: FrameHead, parts: ArrayBuffer[]) {
  const type = MIME[m.fmt] || 'image/jpeg'; // fmt 來自 host，只認這三種
  const src = URL.createObjectURL(new Blob(parts, { type }));
  vurls.push(src);
  if (vurls.length > 4) URL.revokeObjectURL(vurls.shift()!);
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

chrome.runtime.onMessage.addListener((m: Msg) => {
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
