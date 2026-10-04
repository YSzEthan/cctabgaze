// host 端 WebRTC。offscreen 頁面只能用 chrome.runtime：讀寫 storage、截圖都交給背景程式
// 每條連線一個物件 c，所有回呼只認「自己是不是目前這條」：被取代的連線不會再發任何訊息、也不會動到新連線
const raw = (m) => chrome.runtime.sendMessage({ target: 'sw', ...m }).catch(() => {});
const log = (...a) => raw({ type: 'log', line: a.join(' ') });
let cur = null; // { id, pc, ch, dropTimer, dead, nets, verified, opened }

const send = (c, m) => { if (c === cur) raw({ ...m, id: c.id }); }; // 上行訊息一律帶連線編號
function die(c) { // 連線結束的唯一出口，只通知一次
  if (c !== cur || c.dead) return;
  c.dead = true;
  send(c, { type: 'closed' });
}
function idleCheck() { // 兩條連線（host 與 viewer）都沒了，請背景程式把這個 offscreen 文件關掉
  setTimeout(() => { if (!cur && !vc) raw({ type: 'idle' }); }, 1500);
}
function closeConn(c) {
  clearTimeout(c.dropTimer);
  c.pc.onconnectionstatechange = null;
  if (c.ch) { c.ch.onclose = null; c.ch.onbufferedamountlow = null; }
  c.pc.close();
}

// 連上後檢查實際選用的兩端位址；通過才開始傳畫面與收輸入。選用的 pair 之後若換了也重查，不通過就收線
async function verifyConn(c) {
  const r = await checkPair(c.pc, c.nets);
  if (c !== cur || c.dead) return;
  log('選用 pair:', r.local, '→', r.remote, r.ok ? '' : '（不在允許網段內，關閉連線）');
  if (!r.ok) return die(c);
  c.verified = true;
  tryOpen(c);
}
function tryOpen(c) {
  if (!c.verified || c.opened || c.ch?.readyState !== 'open') return;
  c.opened = true;
  send(c, { type: 'open' });
}

async function answer(m) {
  if (cur) closeConn(cur);
  const p = new RTCPeerConnection({ iceServers: [] });
  const c = cur = { id: m.id, pc: p, ch: null, dropTimer: null, dead: false, nets: netsOrDefault(m.nets), verified: false, opened: false };
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
    ch.onmessage = (e) => { // 只收短字串並解析；真正的檢查在背景程式的 input()
      if (!c.verified || typeof e.data !== 'string' || e.data.length > 4096) return;
      try { send(c, { type: 'input', ev: JSON.parse(e.data) }); } catch {}
    };
    ch.onclose = () => die(c);
    ch.onopen = () => tryOpen(c);
    tryOpen(c);
  };
  const offer = keepAllowed(m.sdp, c.nets);
  log('offer 保留的允許網段 candidate 數:', offer.kept);
  if (!offer.kept) return send(c, { type: 'answer-failed', reason: 'no-net' });
  await p.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
  await p.setLocalDescription(await p.createAnswer());
  await gathered(p);
  if (c !== cur) return; // 等待期間已被新連線取代
  const ans = keepAllowed(p.localDescription.sdp, c.nets);
  log('answer 保留的允許網段 candidate 數:', ans.kept);
  if (!ans.kept) return send(c, { type: 'answer-failed', reason: 'no-net' });
  send(c, { type: 'answer', sdp: ans.sdp });
}

// 一張畫面 = 一筆標頭 + 若干二進位區塊；緩衝清空才通知背景程式（帶畫面序號），這是唯一的背壓機制，沒有備援計時器
function sendFrame(c, m) {
  const u = Uint8Array.from(atob(m.b64), (x) => x.charCodeAt(0));
  const CH = Math.min(60000, c.pc.sctp?.maxMessageSize || 60000);
  c.ch.send(JSON.stringify({ type: 'h', chunks: Math.ceil(u.length / CH), state: m.state, tabId: m.tabId, ts: m.ts }));
  for (let i = 0; i < u.length; i += CH) c.ch.send(u.subarray(i, i + CH));
  const done = () => { c.ch.onbufferedamountlow = null; send(c, { type: 'ready', seq: m.seq }); };
  c.ch.onbufferedamountlow = done;
  if (c.ch.bufferedAmount === 0) done();
}

chrome.runtime.onMessage.addListener((m) => {
  if (m.target !== 'offscreen') return;
  if (m.type === 'offer') return answer(m).catch((e) => { log('answer 失敗:', e.message); if (cur?.id === m.id) send(cur, { type: 'answer-failed' }); });
  if (m.type === 'reset') { // 背景程式重新啟動：它已不記得這條連線，直接收掉（不送 end，讓 viewer 走自動重連）
    if (cur) { closeConn(cur); cur = null; idleCheck(); }
    return;
  }
  const c = cur;
  if (!c || m.id !== c.id) return; // 不是目前這條連線的訊息
  if (m.type === 'end') {
    if (c.ch?.readyState === 'open') c.ch.send(JSON.stringify({ type: 'end', reason: m.reason }));
    return void setTimeout(() => { if (cur === c) { closeConn(c); cur = null; idleCheck(); } }, 500);
  }
  if (c.ch?.readyState !== 'open') return;
  if (m.type === 'frame') sendFrame(c, m);
  if (m.type === 'ctl') c.ch.send(JSON.stringify(m.msg));
});
