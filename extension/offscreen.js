// host 端 WebRTC。offscreen 頁面只能用 chrome.runtime：讀寫 storage、截圖都交給背景程式
// 每條連線一個物件 c，所有回呼只認「自己是不是目前這條」：被取代的連線不會再發任何訊息、也不會動到新連線
const raw = (m) => chrome.runtime.sendMessage({ target: 'sw', ...m }).catch(() => {});
const log = (...a) => raw({ type: 'log', line: a.join(' ') });
let cur = null; // { id, pc, ch, dropTimer, readyTimer, dead }

const send = (c, m) => { if (c === cur) raw({ ...m, id: c.id }); }; // 上行訊息一律帶連線編號
function die(c) { // 連線結束的唯一出口，只通知一次
  if (c !== cur || c.dead) return;
  c.dead = true;
  send(c, { type: 'closed' });
}
function closeConn(c) {
  clearTimeout(c.dropTimer); clearTimeout(c.readyTimer);
  c.pc.onconnectionstatechange = null;
  if (c.ch) { c.ch.onclose = null; c.ch.onbufferedamountlow = null; }
  c.pc.close();
}

async function answer(m) {
  if (cur) closeConn(cur);
  const p = new RTCPeerConnection({ iceServers: [] });
  const c = cur = { id: m.id, pc: p, ch: null, dropTimer: null, readyTimer: null, dead: false };
  p.onconnectionstatechange = async () => {
    if (c !== cur) return;
    log('connection', p.connectionState);
    clearTimeout(c.dropTimer);
    if (p.connectionState === 'connected') {
      const stats = await p.getStats();
      stats.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) { const pr = stats.get(r.selectedCandidatePairId); const l = stats.get(pr.localCandidateId), x = stats.get(pr.remoteCandidateId); log('選用 pair:', l.address, '→', x.address); } });
    }
    if (['failed', 'closed'].includes(p.connectionState)) die(c);
    if (p.connectionState === 'disconnected') c.dropTimer = setTimeout(() => { if (p.connectionState === 'disconnected') die(c); }, 10000);
  };
  p.ondatachannel = (e) => {
    const ch = c.ch = e.channel;
    ch.binaryType = 'arraybuffer';
    ch.bufferedAmountLowThreshold = 0;
    ch.onmessage = (e) => { // 只收短字串並解析；真正的檢查在背景程式的 input()
      if (typeof e.data !== 'string' || e.data.length > 4096) return;
      try { send(c, { type: 'input', ev: JSON.parse(e.data) }); } catch {}
    };
    ch.onclose = () => die(c);
    const open = () => send(c, { type: 'open' });
    if (ch.readyState === 'open') open(); else ch.onopen = open;
  };
  const offer = keepTailscaleOnly(m.sdp);
  log('offer 保留的 Tailscale candidate 數:', offer.kept);
  await p.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
  await p.setLocalDescription(await p.createAnswer());
  await gathered(p);
  if (c !== cur) return; // 等待期間已被新連線取代
  const ans = keepTailscaleOnly(p.localDescription.sdp);
  log('answer 保留的 Tailscale candidate 數:', ans.kept);
  send(c, { type: 'answer', sdp: ans.sdp });
}

// 一張畫面 = 一筆標頭 + 若干二進位區塊；等待送完才通知背景程式截下一張
function sendFrame(c, m) {
  const u = Uint8Array.from(atob(m.b64), (x) => x.charCodeAt(0));
  const CH = Math.min(60000, c.pc.sctp?.maxMessageSize || 60000);
  c.ch.send(JSON.stringify({ type: 'h', chunks: Math.ceil(u.length / CH), state: m.state, tabId: m.tabId, ts: m.ts }));
  for (let i = 0; i < u.length; i += CH) c.ch.send(u.subarray(i, i + CH));
  const done = () => { clearTimeout(c.readyTimer); c.ch.onbufferedamountlow = null; send(c, { type: 'ready' }); };
  clearTimeout(c.readyTimer);
  c.ch.onbufferedamountlow = done;
  c.readyTimer = setTimeout(done, 3000);
  if (c.ch.bufferedAmount === 0) done();
}

chrome.runtime.onMessage.addListener((m) => {
  if (m.target !== 'offscreen') return;
  if (m.type === 'offer') return answer(m).catch((e) => log('answer 失敗:', e.message));
  const c = cur;
  if (!c || m.id !== c.id) return; // 不是目前這條連線的訊息
  if (m.type === 'end') {
    if (c.ch?.readyState === 'open') c.ch.send(JSON.stringify({ type: 'end', reason: m.reason }));
    return void setTimeout(() => { if (cur === c) { closeConn(c); cur = null; } }, 500);
  }
  if (c.ch?.readyState !== 'open') return;
  if (m.type === 'frame') sendFrame(c, m);
  if (m.type === 'ctl') c.ch.send(JSON.stringify(m.msg));
});
