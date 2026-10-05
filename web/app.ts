// 手機（或任何瀏覽器）viewer：向信令伺服器 POST offer 換到 answer，再經 WebRTC 看 host 的畫面。
// 目前只看畫面（輸入、分頁列、設定在後續階段）。對方位址手機瀏覽器讀不到，安全靠 token 與 Tailscale，檢查在 host 端做。
import { gathered } from '../src/rtc.ts';
import type { AiState, EndReason, FrameHead, HostWire } from '../src/protocol.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const vid = $<HTMLVideoElement>('vid'), img = $<HTMLImageElement>('img');
const STATE_TEXT: Record<AiState, string> = { running: '⌛ AI 執行中', permission: '🔔 AI 等待授權', done: '✅ AI 已完成', idle: 'AI 閒置' };
const END_TEXT: Partial<Record<EndReason, string>> = { 'ai-ended': 'AI 已結束', replaced: '已被另一台 viewer 取代', 'host-canceled': 'host 端取消了連線' };
const ERROR_TEXT: Record<string, string> = {
  'ai-idle': 'AI 目前沒有在運作（host 沒有 Claude 分頁群組）',
  'no-net': 'host 沒有符合允許網段的位址，無法連線',
  'host-offline': 'host 沒有連上信令伺服器（插件沒開，或沒有設定伺服器）',
  'host-restarted': 'host 剛重新連線，請再試一次',
  timeout: 'host 沒有回應',
};
const RX_TIMEOUT = 10000; // host 最慢約 5 秒必有一筆資料（畫面或 same）；10 秒沒收到視為中斷

// ---- token：只存在這支手機的 localStorage。第一次可用網址 #t=… 帶入（片段不會送到伺服器，讀完就從網址移除）----
const TOKEN_KEY = 'cg_token';
const token = {
  get: () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set: (t: string) => { try { localStorage.setItem(TOKEN_KEY, t); } catch {} },
  del: () => { try { localStorage.removeItem(TOKEN_KEY); } catch {} },
};
const hash = /^#t=(.+)$/.exec(location.hash);
if (hash?.[1]) { token.set(decodeURIComponent(hash[1])); history.replaceState(null, '', location.pathname + location.search); }

// ---- 畫面 ----
const setStatus = (t: string) => { $('status').textContent = t; };
const setMsg = (t: string) => { $('msg').textContent = t; $('msg').hidden = !t; };
const showSetup = (on: boolean) => { $('setup').hidden = !on; if (on) { vid.hidden = img.hidden = true; setMsg(''); $('token').focus(); } };

interface Conn {
  pc: RTCPeerConnection;
  frame: { m: FrameHead; parts: ArrayBuffer[] } | null;
  lastRx: number;
  watch: ReturnType<typeof setInterval> | undefined;
  urls: string[];
  view: 'img' | 'vid' | null;
}
let cur: Conn | null = null;

function stop() {
  const c = cur; cur = null;
  if (!c) return;
  clearInterval(c.watch);
  c.pc.onconnectionstatechange = null;
  c.pc.close();
  c.urls.forEach((u) => URL.revokeObjectURL(u));
  vid.srcObject = null;
}
function end(c: Conn, text: string) { // 連線結束的出口：只處理目前這條
  if (c !== cur) return;
  stop();
  setStatus(text);
  vid.hidden = img.hidden = true;
  setMsg(text);
  $('go').textContent = '重新連線';
}

// 要硬體編碼的那幾組 H264（packetization-mode=1；Safari 是 640c1f 與 42e01f）。瀏覽器沒有 H264 就不要視訊，host 會改走圖片
function addVideo(pc: RTCPeerConnection) {
  const ok = (k: RTCRtpCodec) => k.mimeType === 'video/rtx' || (k.mimeType === 'video/H264' && /packetization-mode=1/.test(k.sdpFmtpLine ?? '') && /profile-level-id=(64|4d|42)/.test(k.sdpFmtpLine ?? ''));
  const codecs = RTCRtpReceiver.getCapabilities('video')?.codecs.filter(ok) ?? [];
  if (!codecs.some((k) => k.mimeType === 'video/H264')) return;
  const tr = pc.addTransceiver('video', { direction: 'recvonly' });
  tr.setCodecPreferences(codecs);
  try { (tr.receiver as RTCRtpReceiver & { jitterBufferTarget: number | null }).jitterBufferTarget = 0; } catch {}
}

async function exchange(sdp: string, t: string): Promise<{ sdp?: string; error?: string }> {
  const res = await fetch('/offer', { method: 'POST', headers: { authorization: 'Bearer ' + t }, body: JSON.stringify({ sdp }), signal: AbortSignal.timeout(25000) });
  if (res.status === 401) { token.del(); return { error: 'unauthorized' }; }
  if (!res.ok) return { error: 'server-' + res.status };
  return res.json();
}

async function connect() {
  const t = token.get();
  if (!t) return showSetup(true);
  showSetup(false);
  stop();
  setStatus('連線中…'); setMsg('連線中…'); $('go').textContent = '連線中';
  const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
  const dc = pc.createDataChannel('v');
  dc.binaryType = 'arraybuffer';
  const c: Conn = cur = { pc, frame: null, lastRx: Date.now(), watch: undefined, urls: [], view: null };
  addVideo(pc);
  pc.ontrack = (e) => { if (c === cur && e.track.kind === 'video') { vid.srcObject = new MediaStream([e.track]); vid.play().catch(() => {}); } };
  dc.onmessage = (e) => onData(c, e);
  dc.onclose = () => end(c, '連線已中斷');
  pc.onconnectionstatechange = () => {
    if (c !== cur) return;
    if (pc.connectionState === 'connected') {
      c.lastRx = Date.now();
      c.watch = setInterval(() => { if (Date.now() - c.lastRx > RX_TIMEOUT) end(c, `超過 ${RX_TIMEOUT / 1000} 秒沒收到資料，視為中斷`); }, 2000);
    }
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') end(c, '連線失敗（確認手機的 Tailscale 有開）');
  };
  try {
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);
    if (c !== cur) return; // 等待期間被新的連線取代
    const r = await exchange(pc.localDescription?.sdp ?? '', t);
    if (c !== cur) return;
    if (r.error === 'unauthorized') { end(c, 'token 不正確'); return showSetup(true); }
    if (!r.sdp) return end(c, (r.error && ERROR_TEXT[r.error]) || `連線失敗：${r.error ?? '未知原因'}`);
    await pc.setRemoteDescription({ type: 'answer', sdp: r.sdp });
  } catch (e) {
    end(c, e instanceof Error && e.name === 'TimeoutError' ? '伺服器沒有回應' : `連線失敗：${e instanceof Error ? e.message : e}`);
  }
}

// ---- host 傳來的資料：畫面是一筆 h 標頭加若干二進位區塊，或視訊模式的 v（像素在視訊軌裡）----
const MIME: Record<string, string> = { jpeg: 'image/jpeg', webp: 'image/webp', png: 'image/png' };
function onData(c: Conn, e: MessageEvent) {
  if (c !== cur) return;
  c.lastRx = Date.now();
  if (typeof e.data !== 'string') {
    if (!c.frame) return;
    c.frame.parts.push(e.data);
    if (c.frame.parts.length >= c.frame.m.chunks) { showImage(c, c.frame.m, c.frame.parts); c.frame = null; }
    return;
  }
  let m: HostWire;
  try { m = JSON.parse(e.data); } catch { return; }
  if (m.type === 'h') c.frame = { m, parts: [] };
  if (m.type === 'v') { c.view = 'vid'; setStatus(STATE_TEXT[m.state] ?? ''); }
  if (m.type === 'same') setStatus(STATE_TEXT[m.state] ?? '');
  if (m.type === 'error') { vid.hidden = img.hidden = true; setMsg(m.message); }
  if (m.type === 'end') end(c, END_TEXT[m.reason] ?? '連線已結束');
}
function showImage(c: Conn, m: FrameHead, parts: ArrayBuffer[]) {
  c.view = 'img';
  const src = URL.createObjectURL(new Blob(parts, { type: MIME[m.fmt] ?? 'image/jpeg' })); // fmt 來自 host，只認這三種
  c.urls.push(src);
  if (c.urls.length > 4) URL.revokeObjectURL(c.urls.shift()!);
  img.src = src; img.hidden = false; vid.hidden = true; setMsg('');
  setStatus(STATE_TEXT[m.state] ?? '');
}
// 視訊真的出了一張畫面才顯示它（第一張可能要等一下；收到訊息就顯示會黑畫面或閃舊畫面）
const onVideoFrame = () => {
  vid.requestVideoFrameCallback(onVideoFrame);
  if (cur?.view !== 'vid') return;
  vid.hidden = false; img.hidden = true; setMsg('');
};
vid.requestVideoFrameCallback(onVideoFrame);

$('go').onclick = () => { connect(); };
$('setup').onsubmit = (e) => {
  e.preventDefault();
  const v = $<HTMLInputElement>('token').value.trim();
  if (!v) return;
  token.set(v);
  $<HTMLInputElement>('token').value = '';
  connect();
};
if (token.get()) connect(); else showSetup(true);
