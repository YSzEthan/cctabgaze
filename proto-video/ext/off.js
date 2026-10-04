// 實驗：擷取分頁 → RTCPeerConnection（指定編碼）→ 同一份文件裡的另一個 RTCPeerConnection 接收並解碼。
// 兩端都在本機，量的是擷取、編碼、解碼本身，不含真實網路。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sameCodec = (a, b) => a.mimeType === b.mimeType && (a.sdpFmtpLine || '') === (b.sdpFmtpLine || '');

chrome.runtime.onMessage.addListener((m, _s, reply) => {
  if (m.to !== 'off') return;
  if (m.cmd === 'frame') return void sink?.(m);
  (m.cmd === 'caps' ? caps() : m.cmd === 'shotrun' ? shotRun(m) : run(m)).then(reply, (e) => reply({ error: String(e.message || e) }));
  return true;
});

const real = (c) => !/\/(rtx|red|ulpfec|flexfec-03)$/i.test(c.mimeType);
async function caps() {
  return { send: RTCRtpSender.getCapabilities('video').codecs.filter(real), recv: RTCRtpReceiver.getCapabilities('video').codecs.filter(real) };
}

// 讀測試頁最上面的條碼（見 test/fixtures/page.html）：回傳繪製當下的 Date.now() 低 32 位元，讀不到回傳 null
const cv = new OffscreenCanvas(340, 1), cx = cv.getContext('2d', { willReadFrequently: true });
function readStamp(frame) {
  cx.drawImage(frame, 0, frame.displayHeight * 0.01, frame.displayWidth, frame.displayHeight * 0.02, 0, 0, 340, 1);
  const d = cx.getImageData(0, 0, 340, 1).data, bit = (i) => d[(i * 10 + 5) * 4] < 128;
  if (bit(0) || !bit(1)) return null;
  let v = 0;
  for (let i = 2; i < 34; i++) v = v * 2 + (bit(i) ? 1 : 0);
  return v;
}

const pick = (report, type, kind) => { let r = null; report.forEach((s) => { if (s.type === type && (!kind || s.kind === kind)) r = s; }); return r; };
const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : null);

async function run(m) {
  // 上限設成分頁本身的像素大小：設得更大 Chrome 會把畫面放大並補黑邊
  const stream = await navigator.mediaDevices.getUserMedia({ video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: m.streamId, maxFrameRate: m.fps, maxWidth: m.width, maxHeight: m.height } } });
  return measure(stream.getVideoTracks()[0], m);
}

// 截圖當來源：背景程式送來的每張截圖解碼成 VideoFrame，寫進一條自己產生的視訊軌，之後和分頁擷取走同一套量測。
// 解碼還沒完成時又來新的，只留最新一張
let sink = null;
async function shotRun(m) {
  const gen = new MediaStreamTrackGenerator({ kind: 'video' }), w = gen.writable.getWriter();
  gen.contentHint = 'detail'; // 當成螢幕內容：頻寬不夠時降 fps，不要降解析度（沒設的話 H264 會縮成 960x567）
  let busy = false, next = null, counting = false;
  const st = { shots: 0, bytes: 0, capMs: 0, decMs: 0, written: 0, skipped: 0 };
  const pump = async (f) => {
    busy = true;
    try {
      for (; f; f = next, next = null) {
        const t = performance.now();
        const bmp = await createImageBitmap(new Blob([Uint8Array.fromBase64(f.b64)], { type: 'image/' + f.fmt }));
        // 寬高裁成偶數：1280x757 這種奇數高度會讓 H264 退回軟體編碼（每張 20 到 30 ms）
        const vf = new VideoFrame(bmp, { timestamp: Math.round(performance.now() * 1000), visibleRect: { x: 0, y: 0, width: bmp.width & ~1, height: bmp.height & ~1 } });
        bmp.close();
        const dec = performance.now() - t;
        await w.write(vf);
        if (counting) { st.written++; st.decMs += dec; }
      }
    } finally { busy = false; }
  };
  sink = (f) => {
    if (counting) { st.shots++; st.bytes += f.b64.length * 0.75; st.capMs += f.capMs; }
    if (busy) { if (next && counting) st.skipped++; next = f; } else pump(f).catch(() => {});
  };
  try {
    return await measure(gen, m, {
      start: () => { counting = true; },
      stop: (dt) => { counting = false; return {
        shotFps: +(st.shots / dt).toFixed(1), shotMs: +(st.capMs / st.shots).toFixed(1), shotKB: +(st.bytes / st.shots / 1000).toFixed(1),
        imageKbps: Math.round(st.bytes * 8 / dt / 1000), toFrameMs: +(st.decMs / st.written).toFixed(1), skipped: st.skipped,
      }; },
    });
  } finally { sink = null; }
}

async function measure(track, { codec, seconds, warmup, fps, maxBitrate }, probe) {
  const a = new RTCPeerConnection(), b = new RTCPeerConnection();
  try {
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
    const tr = a.addTransceiver(track, { direction: 'sendonly', sendEncodings: [{ maxBitrate, maxFramerate: fps }] });
    // 先照送出端列的編碼原樣指定；接收端的參數寫法不同（例如 H265 的 level）時，退回只比對編碼名稱
    const rx = RTCRtpReceiver.getCapabilities('video').codecs;
    const exact = rx.filter((c) => sameCodec(c, codec));
    try { tr.setCodecPreferences(exact.length ? exact : [codec]); }
    catch { tr.setCodecPreferences(rx.filter((c) => c.mimeType === codec.mimeType)); }
    const remote = new Promise((r) => { b.ontrack = (e) => r(e.track); });
    await a.setLocalDescription(await a.createOffer());
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription);

    // 接收端逐張讀解碼後的畫面：算延遲、數不重複的畫面
    const lats = [], seen = new Set();
    let frames = 0, on = false, stop = false;
    const reader = new MediaStreamTrackProcessor({ track: await remote }).readable.getReader();
    (async () => {
      for (;;) {
        const { value: f, done } = await reader.read();
        if (done || stop) { f?.close(); break; }
        if (on) {
          frames++;
          const v = readStamp(f);
          if (v != null) { seen.add(v); const lat = (Date.now() % 2 ** 32) - v; if (lat >= 0 && lat < 5000) lats.push(lat); }
        }
        f.close();
      }
    })();

    // 等編碼器真的編出第一張（硬體編碼器初始化可能較久），再暖機
    let started = null;
    for (let i = 0; i < 40 && !started; i++) { await sleep(250); const o = pick(await a.getStats(), 'outbound-rtp', 'video'); if (o?.framesEncoded > 0) started = o; }
    if (!started) { const o = pick(await a.getStats(), 'outbound-rtp', 'video'); return { error: `10 秒內沒有編出任何畫面（encoder=${o?.encoderImplementation ?? '無'}，track=${track.readyState}，ice=${a.iceConnectionState}）` }; }
    await sleep(warmup);
    const s0 = await a.getStats(), r0 = await b.getStats(), t0 = performance.now();
    on = true; probe?.start();
    await sleep(seconds * 1000);
    on = false;
    const s1 = await a.getStats(), r1 = await b.getStats(), dt = (performance.now() - t0) / 1000;
    const extra = probe?.stop(dt);
    stop = true;

    const o0 = pick(s0, 'outbound-rtp', 'video'), o1 = pick(s1, 'outbound-rtp', 'video');
    const i0 = pick(r0, 'inbound-rtp', 'video'), i1 = pick(r1, 'inbound-rtp', 'video');
    if (!o0 || !o1 || !i0 || !i1) return { error: '沒有 RTP 統計（沒有送出任何畫面）' };
    const used = s1.get(o1.codecId) || {};
    const enc = o1.framesEncoded - o0.framesEncoded, dec = i1.framesDecoded - i0.framesDecoded;
    lats.sort((x, y) => x - y);
    return {
      used: used.mimeType + (used.sdpFmtpLine ? ' ' + used.sdpFmtpLine : ''),
      encoder: o1.encoderImplementation, hwEnc: o1.powerEfficientEncoder, decoder: i1.decoderImplementation, hwDec: i1.powerEfficientDecoder,
      size: `${o1.frameWidth}x${o1.frameHeight}`, captured: track.getSettings().frameRate,
      encFps: +(enc / dt).toFixed(1), rxFps: +(frames / dt).toFixed(1), uniqueFps: +(seen.size / dt).toFixed(1),
      kbps: Math.round((o1.bytesSent - o0.bytesSent) * 8 / dt / 1000),
      encMs: enc ? +((o1.totalEncodeTime - o0.totalEncodeTime) / enc * 1000).toFixed(1) : null,
      decMs: dec ? +((i1.totalDecodeTime - i0.totalDecodeTime) / dec * 1000).toFixed(1) : null,
      limit: o1.qualityLimitationReason, dropped: i1.framesDropped - i0.framesDropped,
      latP50: pct(lats, 0.5), latP95: pct(lats, 0.95), stamps: lats.length, ...extra,
    };
  } finally {
    track.stop(); a.close(); b.close();
  }
}
