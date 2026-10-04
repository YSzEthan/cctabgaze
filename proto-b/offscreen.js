// offscreen 頁面只能用 chrome.runtime：所有讀寫 storage 的事都交給背景程式
const send = (m) => chrome.runtime.sendMessage({ target: 'sw', ...m });
const log = (...a) => send({ type: 'log', line: a.join(' ') });
let pc = null;

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

chrome.runtime.onMessage.addListener(async (m) => {
  if (m.target !== 'offscreen' || m.type !== 'offer') return;
  if (pc) pc.close();
  pc = new RTCPeerConnection({ iceServers: [] });
  const p = pc;
  p.onconnectionstatechange = () => { log('connection', p.connectionState); if (p.connectionState === 'connected') report(p); };
  p.ondatachannel = (e) => {
    log('DataChannel 到達');
    let got = 0;
    e.channel.onmessage = (x) => { const y = JSON.parse(x.data); got++; log('#' + y.n, '到達，單程約', Date.now() - y.t, 'ms（含時鐘誤差）'); e.channel.send(JSON.stringify({ n: y.n, t: y.t })); if (y.n === 9) log('收到並回應了', got, '筆'); };
  };
  await p.setRemoteDescription({ type: 'offer', sdp: m.sdp });
  await p.setLocalDescription(await p.createAnswer());
  await gathered(p);
  send({ type: 'answer', sdp: p.localDescription.sdp });
});
