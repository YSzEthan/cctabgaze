// host 端 WebRTC。offscreen 頁面只能用 chrome.runtime：讀寫 storage、截圖都交給背景程式
// 每條連線一個物件 c，所有回呼只認「自己是不是目前這條」：被取代的連線不會再發任何訊息、也不會動到新連線
import { checkPair, gathered, keepAllowed, netsOrDefault, type Net } from './rtc.ts';
import { idleCheck, keepsAlive } from './idle.ts';
import type { FrameHead, HostUp, HostWire, Msg, OffBody, OfferMsg, SwMsg } from './protocol.ts';

interface Conn {
  id: string;
  pc: RTCPeerConnection;
  ch: RTCDataChannel | null;
  dropTimer: ReturnType<typeof setTimeout> | undefined;
  dead: boolean;
  nets: Net[];
  lax: boolean; // 信令伺服器來的 offer（手機 viewer）：offer 不必有允許網段的位址，對方位址讀不到也可以
  verified: boolean;
  opened: boolean;
  pairWatched: boolean;
  video: VideoOut | null; // 視訊軌協商成功才有；本機編碼壞掉或兩條路不同源就設回 null
  videoTr: RTCRtpTransceiver | null;
  statsTimer: ReturnType<typeof setInterval> | undefined;
  prev: { t: number; frames: number; bytes: number; encodeS: number } | null;
}

// 視訊模式：截圖 → ImageBitmap → VideoFrame → generator → 視訊軌。bmp 是上一張，靜止時重寫它（VideoFrame 寫入後會被關掉，不能留）
interface VideoOut { gen: MediaStreamTrackGenerator; w: WritableStreamDefaultWriter<VideoFrame>; bmp: ImageBitmap | null }

const raw = (m: SwMsg) => chrome.runtime.sendMessage(m).catch(() => {});
const log = (...a: unknown[]) => raw({ target: 'sw', type: 'log', line: a.join(' ') });
let cur: Conn | null = null;
keepsAlive(() => !!cur);

const send = (c: Conn, m: HostUp) => { if (c === cur) raw({ target: 'sw', ...m, id: c.id }); }; // 上行訊息一律帶連線編號
const wire = (ch: RTCDataChannel, m: HostWire) => ch.send(JSON.stringify(m));
function die(c: Conn) { // 連線結束的唯一出口，只通知一次
  if (c !== cur || c.dead) return;
  c.dead = true;
  send(c, { type: 'closed' });
}
function closeVideo(c: Conn) { // 硬體編碼器同時使用數有限，連線結束一定要放掉
  const v = c.video;
  c.video = null;
  if (!v) return;
  v.bmp?.close();
  v.w.close().catch(() => {});
  v.gen.stop();
}
function closeConn(c: Conn) {
  clearTimeout(c.dropTimer);
  closeVideo(c);
  clearInterval(c.statsTimer);
  c.pc.onconnectionstatechange = null;
  if (c.ch) { c.ch.onclose = null; c.ch.onbufferedamountlow = null; }
  c.pc.close();
}

// 連上後檢查實際選用的兩端位址；通過才開始傳畫面與收輸入。選用的 pair 之後若換了也重查，不通過就收線
async function verifyConn(c: Conn) {
  const r = await checkPair(c.pc, c.nets, c.lax);
  if (c !== cur || c.dead) return;
  log('選用 pair:', r.local, '→', r.remote, r.ok ? '' : '（不在允許網段內，關閉連線）');
  if (!r.ok) return die(c);
  c.verified = true;
  tryOpen(c);
}
// 視訊要同時滿足：有協商到 H264、和 DataChannel 同一條 DTLS（位址檢查才涵蓋視訊；offer 是不可信的資料，不能只信設定）
function videoUsable(c: Conn) {
  const tr = c.videoTr;
  if (!c.video || !tr) return false;
  const h264 = tr.sender.getParameters().codecs.some((k) => k.mimeType === 'video/H264');
  const same = !!tr.sender.transport && tr.sender.transport === c.pc.sctp?.transport;
  if (!h264 || !same) log('視訊不可用：H264', h264, '，同一條連線', same);
  return h264 && same;
}
// 每 5 秒一行：視訊編出幾 fps、位元率、被什麼限制，以及 WebRTC 對網路的估計。看瓶頸是編碼、頻寬還是網路
async function logVideoStats(c: Conn) {
  if (c !== cur || !c.video) return;
  const stats = await c.pc.getStats();
  let out: any, remote: any, pair: any; // RTCStatsReport 的項目在 lib.dom 裡本來就是 any
  stats.forEach((r) => {
    if (r.type === 'outbound-rtp' && r.kind === 'video') out = r;
    if (r.type === 'remote-inbound-rtp' && r.kind === 'video') remote = r;
    if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId);
  });
  if (!out) return;
  const cur2 = { t: out.timestamp as number, frames: out.framesEncoded as number, bytes: out.bytesSent as number, encodeS: (out.totalEncodeTime ?? 0) as number };
  const p = c.prev;
  c.prev = cur2;
  if (!p || cur2.t <= p.t) return;
  const dt = (cur2.t - p.t) / 1000, n = cur2.frames - p.frames;
  const kbps = (x: unknown) => (typeof x === 'number' ? Math.round(x / 1000) : '-');
  log('[視訊] 編出', (n / dt).toFixed(1), 'fps，', Math.round((cur2.bytes - p.bytes) * 8 / dt / 1000), 'kbps，編碼', n ? ((cur2.encodeS - p.encodeS) / n * 1000).toFixed(1) : '-', 'ms/張，', `${out.frameWidth}x${out.frameHeight}`,
    '；限制', out.qualityLimitationReason ?? '-', '；估計可用頻寬', kbps(pair?.availableOutgoingBitrate), 'kbps，RTT', typeof pair?.currentRoundTripTime === 'number' ? Math.round(pair.currentRoundTripTime * 1000) : '-', 'ms，遺失', typeof remote?.fractionLost === 'number' ? (remote.fractionLost * 100).toFixed(1) + '%' : '-', '；編碼器', out.encoderImplementation ?? '?');
}

function tryOpen(c: Conn) {
  if (!c.verified || c.opened || c.ch?.readyState !== 'open') return;
  c.opened = true;
  if (c.video && !videoUsable(c)) closeVideo(c);
  if (c.video) { capBitrate(c); c.statsTimer = setInterval(() => logVideoStats(c).catch(() => {}), 5000); }
  send(c, { type: 'open', video: !!c.video });
}
function capBitrate(c: Conn) { // 位元率上限；失敗不影響連線
  const s = c.videoTr?.sender;
  const p = s?.getParameters();
  if (!s || !p?.encodings[0]) return;
  p.encodings[0].maxBitrate = 8_000_000;
  s.setParameters(p).catch(() => {});
}

async function answer(m: OfferMsg) {
  if (cur) closeConn(cur);
  const p = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
  const c: Conn = cur = { id: m.id, pc: p, ch: null, dropTimer: undefined, dead: false, nets: netsOrDefault(m.nets), lax: m.lax, verified: false, opened: false, pairWatched: false, video: null, videoTr: null, statsTimer: undefined, prev: null };
  p.onconnectionstatechange = async () => {
    if (c !== cur) return;
    log('connection', p.connectionState);
    clearTimeout(c.dropTimer);
    if (p.connectionState === 'connected') {
      if (!c.pairWatched) { c.pairWatched = true; p.sctp?.transport?.iceTransport?.addEventListener('selectedcandidatepairchange', () => verifyConn(c)); }
      verifyConn(c);
    }
    if (['failed', 'closed'].includes(p.connectionState)) die(c);
    if (p.connectionState === 'disconnected') c.dropTimer = setTimeout(() => { if (p.connectionState === 'disconnected') die(c); }, 10000);
  };
  p.ondatachannel = (e) => {
    const ch = c.ch = e.channel;
    ch.binaryType = 'arraybuffer';
    ch.bufferedAmountLowThreshold = 0;
    ch.onmessage = (e: MessageEvent<unknown>) => { // 只收短字串並解析；真正的檢查在背景程式的 input()
      if (!c.verified || typeof e.data !== 'string' || e.data.length > 4096) return;
      try { send(c, { type: 'input', ev: JSON.parse(e.data) }); } catch {}
    };
    ch.onclose = () => die(c);
    ch.onopen = () => tryOpen(c);
    tryOpen(c);
  };
  const offer = keepAllowed(m.sdp, c.nets);
  log('offer 保留的允許網段 candidate 數:', offer.kept);
  if (!offer.kept && !m.lax) return send(c, { type: 'answer-failed', reason: 'no-net' });
  await p.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
  const tr = p.getTransceivers().find((t) => t.receiver.track.kind === 'video');
  if (tr) { // viewer 要了視訊：host 這邊用 generator 當來源；失敗就只走圖片
    try {
      const gen = new MediaStreamTrackGenerator({ kind: 'video' });
      gen.contentHint = 'detail'; // 當成螢幕內容：頻寬不夠時降 fps，不要降解析度
      tr.direction = 'sendonly';
      await tr.sender.replaceTrack(gen);
      c.video = { gen, w: gen.writable.getWriter(), bmp: null };
      c.videoTr = tr;
    } catch (e) { log('視訊來源建立失敗:', e instanceof Error ? e.message : e); }
  }
  await p.setLocalDescription(await p.createAnswer());
  await gathered(p);
  if (c !== cur) return; // 等待期間已被新連線取代
  const ans = keepAllowed(p.localDescription?.sdp ?? '', c.nets);
  log('answer 保留的允許網段 candidate 數:', ans.kept);
  if (!ans.kept) return send(c, { type: 'answer-failed', reason: 'no-net' });
  send(c, { type: 'answer', sdp: ans.sdp });
}

function decodeBase64(b64: string) { // 沒有原生支援時的備援：手寫迴圈比 Uint8Array.from(…, fn) 快約 25 倍
  const bin = atob(b64), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
const toBytes = (b64: string) => Uint8Array.fromBase64?.(b64) ?? decodeBase64(b64); // 原生版（新版 Chrome）每張約 0.01 ms；舊的 atob 加逐字元轉換要 2 ms

// 一張畫面 = 一筆標頭 + 若干二進位區塊；緩衝清空才通知背景程式（帶畫面序號），這是唯一的背壓機制，沒有備援計時器
function sendFrame(c: Conn, ch: RTCDataChannel, m: Extract<OffBody, { type: 'frame' }>) {
  const u = toBytes(m.b64);
  const CH = Math.min(60000, c.pc.sctp?.maxMessageSize || 60000);
  wire(ch, { type: 'h', chunks: Math.ceil(u.length / CH), state: m.state, tabId: m.tabId, ts: m.ts, fmt: m.fmt, vw: m.vw } satisfies FrameHead);
  for (let i = 0; i < u.length; i += CH) ch.send(u.subarray(i, i + CH));
  const done = () => { ch.onbufferedamountlow = null; send(c, { type: 'ready', seq: m.seq }); };
  ch.onbufferedamountlow = done;
  if (ch.bufferedAmount === 0) done();
}

// 寫一張進視訊軌。VideoFrame 寫入後歸 generator 管，這裡每次從 bitmap 重建；寬高裁成偶數（奇數高度會讓 H264 退回軟體編碼）
async function writeBmp(v: VideoOut) {
  const bmp = v.bmp;
  if (!bmp) return;
  await v.w.write(new VideoFrame(bmp, { timestamp: Math.round(performance.now() * 1000), visibleRect: { x: 0, y: 0, width: bmp.width & ~1, height: bmp.height & ~1 } }));
}

function videoFailed(c: Conn, why: unknown) {
  log('視訊編碼失敗，改用圖片:', why instanceof Error ? why.message : why);
  closeVideo(c);
  send(c, { type: 'video-failed' });
}

// 視訊模式的一張：失敗時把同一份位元組交給 sendFrame，它會自己回 ready，背壓不會卡住
async function sendVideo(c: Conn, ch: RTCDataChannel, v: VideoOut, m: Extract<OffBody, { type: 'frame' }>) {
  try {
    const bmp = await createImageBitmap(new Blob([toBytes(m.b64)], { type: 'image/' + m.fmt }));
    v.bmp?.close();
    v.bmp = bmp;
    await writeBmp(v);
    if (c !== cur || ch.readyState !== 'open') return;
    wire(ch, { type: 'v', state: m.state, tabId: m.tabId, ts: m.ts, vw: m.vw });
    send(c, { type: 'ready', seq: m.seq });
  } catch (e) {
    videoFailed(c, e);
    if (c === cur && ch.readyState === 'open') sendFrame(c, ch, m);
  }
}

chrome.runtime.onMessage.addListener((m: Msg) => {
  if (m.target !== 'offscreen') return;
  if (m.type === 'offer') return answer(m).catch((e) => { log('answer 失敗:', e.message); if (cur?.id === m.id) send(cur, { type: 'answer-failed' }); });
  if (m.type === 'reset') { // 背景程式重新啟動：它已不記得這條連線，直接收掉（不送 end，讓 viewer 走自動重連）
    if (cur) { closeConn(cur); cur = null; idleCheck(); }
    return;
  }
  const c = cur;
  if (!c || m.id !== c.id) return; // 不是目前這條連線的訊息
  const ch = c.ch;
  if (m.type === 'end') {
    if (ch?.readyState === 'open') wire(ch, { type: 'end', reason: m.reason });
    return void setTimeout(() => { if (cur === c) { closeConn(c); cur = null; idleCheck(); } }, 500);
  }
  if (ch?.readyState !== 'open') return;
  if (m.type === 'frame') {
    if (m.video && c.video) return void sendVideo(c, ch, c.video, m);
    if (c.video?.bmp) { c.video.bmp.close(); c.video.bmp = null; } // 這張走圖片：之後的 same 不能再重寫舊的視訊畫面
    sendFrame(c, ch, m);
  }
  if (m.type === 'ctl') {
    wire(ch, m.msg);
    const v = c.video; // 靜止頁面：重寫上一張，視訊中途掉一張也不會卡住
    if (m.msg.type === 'same' && v?.bmp) writeBmp(v).catch((e) => videoFailed(c, e));
  }
});
