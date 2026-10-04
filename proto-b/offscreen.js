// offscreen 頁面只能用 chrome.runtime：所有讀寫 storage 的事都交給背景程式
const send = (m) => chrome.runtime.sendMessage({ target: 'sw', ...m });
const log = (...a) => send({ type: 'log', line: a.join(' ') });
let pc = null, ch = null, sent = 0, skipped = 0, ticks = 0;

const gathered = (p) => new Promise((res) => {
  if (p.iceGatheringState === 'complete') return res();
  const t = setTimeout(res, 4000);
  p.addEventListener('icegatheringstatechange', () => { if (p.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
});

async function report(p) {
  const stats = await p.getStats();
  let pair;
  stats.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId); });
  if (!pair) return log('找不到選用的 candidate pair');
  const l = stats.get(pair.localCandidateId), r = stats.get(pair.remoteCandidateId);
  log('選用 pair:', `local ${l.candidateType} ${l.address || l.ip}:${l.port}`, '→', `remote ${r.candidateType} ${r.address || r.ip}:${r.port}`);
}

function sendFrame(b64, t) {
  ticks++;
  if (!ch || ch.readyState !== 'open') return;
  if (ch.bufferedAmount > 0) skipped++; // 上一張還沒送完：丟掉這一張
  else {
    const bin = atob(b64), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const CH = Math.min(60000, (pc.sctp && pc.sctp.maxMessageSize) || 60000);
    ch.send(JSON.stringify({ type: 'h', n: sent, t, size: u.length, chunks: Math.ceil(u.length / CH) }));
    for (let i = 0; i < u.length; i += CH) ch.send(u.subarray(i, i + CH));
    sent++;
  }
  if (ticks % 20 === 0) log(`已過 ${ticks / 2} 秒：送出 ${sent} 張，丟掉 ${skipped} 張，待送 ${ch.bufferedAmount} 位元組`);
}

chrome.runtime.onMessage.addListener(async (m) => {
  if (m.target !== 'offscreen') return;
  if (m.type === 'frame') return sendFrame(m.b64, m.t);
  if (m.type === 'stress-end') {
    if (ch && ch.readyState === 'open') ch.send(JSON.stringify({ type: 'done', sent, skipped }));
    return log(`壓力測試結束：送出 ${sent} 張，丟掉 ${skipped} 張`);
  }
  if (m.type !== 'offer') return;
  if (pc) pc.close();
  pc = new RTCPeerConnection({ iceServers: [] });
  const p = pc;
  p.onconnectionstatechange = () => {
    log('connection', p.connectionState);
    if (p.connectionState === 'connected') report(p);
    if (['failed', 'closed', 'disconnected'].includes(p.connectionState)) send({ type: 'stress-stop' });
  };
  p.ondatachannel = (e) => {
    log('DataChannel 到達，名稱', e.channel.label, '，單一訊息上限', p.sctp && p.sctp.maxMessageSize);
    if (e.channel.label === 'stress') {
      ch = e.channel; ch.binaryType = 'arraybuffer'; sent = 0; skipped = 0; ticks = 0;
      const go = () => send({ type: 'stress-start' });
      if (ch.readyState === 'open') go(); else ch.onopen = go;
      return;
    }
    let got = 0;
    e.channel.onmessage = (x) => { const y = JSON.parse(x.data); got++; e.channel.send(JSON.stringify({ n: y.n, t: y.t })); if (y.n === 9) log('收到並回應了', got, '筆'); };
  };
  await p.setRemoteDescription({ type: 'offer', sdp: m.sdp });
  await p.setLocalDescription(await p.createAnswer());
  await gathered(p);
  send({ type: 'answer', sdp: p.localDescription.sdp });
});
