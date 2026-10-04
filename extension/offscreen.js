// host 端 WebRTC。offscreen 頁面只能用 chrome.runtime：讀寫 storage、截圖都交給背景程式
const send = (m) => chrome.runtime.sendMessage({ target: 'sw', ...m }).catch(() => {});
const log = (...a) => send({ type: 'log', line: a.join(' ') });
let pc = null, ch = null, readyTimer = null, dropTimer = null;

async function answer(m) {
  if (pc) pc.close();
  const p = pc = new RTCPeerConnection({ iceServers: [] });
  ch = null;
  p.onconnectionstatechange = async () => {
    log('connection', p.connectionState);
    clearTimeout(dropTimer);
    if (p.connectionState === 'connected') {
      const stats = await p.getStats();
      stats.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) { const pr = stats.get(r.selectedCandidatePairId); const l = stats.get(pr.localCandidateId), x = stats.get(pr.remoteCandidateId); log('選用 pair:', l.address, '→', x.address); } });
    }
    if (['failed', 'closed'].includes(p.connectionState)) send({ type: 'closed' });
    if (p.connectionState === 'disconnected') dropTimer = setTimeout(() => { if (p.connectionState === 'disconnected') send({ type: 'closed' }); }, 10000);
  };
  p.ondatachannel = (e) => {
    ch = e.channel;
    ch.binaryType = 'arraybuffer';
    ch.bufferedAmountLowThreshold = 0;
    ch.onmessage = (e) => { // 只收短字串並解析；真正的檢查在背景程式的 input()
      if (typeof e.data !== 'string' || e.data.length > 4096) return;
      try { send({ type: 'input', ev: JSON.parse(e.data) }); } catch {}
    };
    ch.onclose = () => send({ type: 'closed' });
    const open = () => send({ type: 'open' });
    if (ch.readyState === 'open') open(); else ch.onopen = open;
  };
  const offer = keepTailscaleOnly(m.sdp);
  log('offer 保留的 Tailscale candidate 數:', offer.kept);
  await p.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
  await p.setLocalDescription(await p.createAnswer());
  await gathered(p);
  const ans = keepTailscaleOnly(p.localDescription.sdp);
  log('answer 保留的 Tailscale candidate 數:', ans.kept);
  send({ type: 'answer', sdp: ans.sdp, id: m.id });
}

// 一張畫面 = 一筆標頭 + 若干二進位區塊；等待送完才通知背景程式截下一張
function sendFrame(m) {
  const u = Uint8Array.from(atob(m.b64), (c) => c.charCodeAt(0));
  const CH = Math.min(60000, pc.sctp?.maxMessageSize || 60000);
  ch.send(JSON.stringify({ type: 'h', chunks: Math.ceil(u.length / CH), title: m.title, url: m.url, state: m.state, tabId: m.tabId, ts: m.ts }));
  for (let i = 0; i < u.length; i += CH) ch.send(u.subarray(i, i + CH));
  const done = () => { clearTimeout(readyTimer); ch.onbufferedamountlow = null; send({ type: 'ready' }); };
  ch.onbufferedamountlow = done;
  readyTimer = setTimeout(done, 3000);
  if (ch.bufferedAmount === 0) done();
}

chrome.runtime.onMessage.addListener((m) => {
  if (m.target !== 'offscreen') return;
  if (m.type === 'offer') return answer(m).catch((e) => log('answer 失敗:', e.message));
  if (m.type === 'end') {
    if (ch && ch.readyState === 'open') ch.send(JSON.stringify({ type: 'end', reason: m.reason }));
    return void setTimeout(() => pc && pc.close(), 500);
  }
  if (!ch || ch.readyState !== 'open') return;
  if (m.type === 'frame') sendFrame(m);
  if (m.type === 'ctl') ch.send(JSON.stringify(m.msg));
});
