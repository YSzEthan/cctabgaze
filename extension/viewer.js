// viewer 端：發起連線、顯示畫面。這台不會對 host 下任何指令（host 也會丟棄 viewer 送來的所有訊息）
const $ = (id) => document.getElementById(id);
const REQ = 'cg_req', RES = 'cg_res';
const STATE_TEXT = { running: '⌛ AI 執行中', permission: '🔔 AI 等待授權', done: '✅ AI 已完成', idle: 'AI 閒置' };
const ROLE_TEXT = { host: '這台是 host（待命：有 Claude 分頁時才回應連線請求）', viewer: '這台是 viewer' };
let pc = null, dc = null, timeoutT = null, curId = null, myId = null, cur = null;
const fps = () => { const now = Date.now(); frameTimes = frameTimes.filter((t) => now - t < 5000); return (frameTimes.length / 5).toFixed(1); };
let lastFrameAt = 0, mode = 'wait', aiState = '', imgUrl = null, retried = false, ended = false, minLat = Infinity, extraLat = 0, frameTimes = [];

const plog = [];
const dlog = (...a) => { plog.push(`[${new Date().toISOString().slice(11, 23)}] ` + a.join(' ')); };
const setStatus = (t) => { $('status').textContent = t; };
const idle = (t) => { setStatus(t); $('connect').disabled = false; }; // 顯示狀態並允許重新連線

async function renderRole() {
  const { role } = await chrome.storage.local.get('role');
  $('role').textContent = ROLE_TEXT[role] || '尚未設定角色';
  $('connect').hidden = role !== 'viewer';
}
const setRole = async (role) => { await chrome.storage.local.set({ role }); renderRole(); };
$('asHost').onclick = () => setRole('host');
$('asViewer').onclick = () => setRole('viewer');

function teardown() {
  chrome.storage.onChanged.removeListener(onRes);
  clearTimeout(timeoutT);
  const p = pc; pc = null; dc = null; cur = null;
  if (p) p.close();
}

function lost(wasConnected) {
  $('connect').disabled = false;
  if (ended) return;
  if (wasConnected && !retried) { retried = true; setStatus('連線中斷，5 秒後自動重連…'); setTimeout(() => connect(true), 5000); }
  else idle('連線失敗或中斷，請按「連線」重試');
}

async function connect(auto = false) {
  teardown();
  if (!auto) retried = false;
  ended = false; mode = 'wait';
  $('connect').disabled = true;
  setStatus('連線中…（約需 10 秒）');
  let { deviceId } = await chrome.storage.local.get('deviceId');
  if (!deviceId) { deviceId = crypto.randomUUID(); await chrome.storage.local.set({ deviceId }); }
  myId = deviceId;
  const p = pc = new RTCPeerConnection({ iceServers: [] });
  let connected = false;
  dc = p.createDataChannel('v');
  dc.binaryType = 'arraybuffer';
  dc.onmessage = onData;
  p.onconnectionstatechange = () => {
    dlog('connection', p.connectionState);
    if (p !== pc) return;
    if (p.connectionState === 'connected') {
      connected = true; retried = false;
      clearTimeout(timeoutT);
      setStatus('已連線，等待畫面…');
      chrome.storage.sync.remove([REQ, RES]);
    }
    if (['failed', 'closed'].includes(p.connectionState)) lost(connected);
  };
  await p.setLocalDescription(await p.createOffer());
  await gathered(p);
  const offer = keepTailscaleOnly(p.localDescription.sdp);
  dlog('offer 保留的 Tailscale candidate 數:', offer.kept);
  if (!offer.kept) return idle('這台沒有 Tailscale 位址，無法連線');
  curId = crypto.randomUUID();
  chrome.storage.onChanged.addListener(onRes);
  await chrome.storage.sync.set({ [REQ]: { id: curId, from: myId, t: Date.now(), sdp: offer.sdp } });
  dlog('連線請求已寫入 sync');
  timeoutT = setTimeout(() => { idle('host 離線或未回應（等了 20 秒）'); chrome.storage.sync.remove([REQ]); }, 20000);
}

async function onRes(ch, area) {
  const r = area === 'sync' && ch[RES] && ch[RES].newValue;
  if (!r || r.to !== myId || r.id !== curId) return;
  clearTimeout(timeoutT);
  dlog('收到 host 回應', r.error || 'answer');
  if (r.error === 'ai-idle') {
    idle('AI 目前沒有在運作（host 沒有 Claude 分頁群組）');
    chrome.storage.sync.remove([REQ, RES]);
    return;
  }
  await pc.setRemoteDescription({ type: 'answer', sdp: keepTailscaleOnly(r.sdp).sdp });
}

function showFrame(m, parts) {
  const url = URL.createObjectURL(new Blob(parts, { type: 'image/jpeg' }));
  $('img').src = url; $('img').hidden = false; $('msg').hidden = true;
  if (imgUrl) URL.revokeObjectURL(imgUrl);
  imgUrl = url;
  $('title').textContent = m.title; $('url').textContent = m.url;
  aiState = STATE_TEXT[m.state] || '';
  lastFrameAt = Date.now(); mode = 'frame';
  // 單程延遲含兩台時鐘誤差；減掉目前看過的最小值，剩下的就是排隊造成的額外延遲
  const lat = lastFrameAt - m.ts; minLat = Math.min(minLat, lat); extraLat = lat - minLat; frameTimes.push(lastFrameAt);
  setStatus(aiState);
}

function onData(e) {
  if (typeof e.data !== 'string') {
    if (!cur) return;
    cur.parts.push(e.data);
    if (cur.parts.length >= cur.m.chunks) { showFrame(cur.m, cur.parts); cur = null; }
    return;
  }
  const m = JSON.parse(e.data);
  if (m.type === 'h') cur = { m, parts: [] };
  if (m.type === 'same') { mode = 'same'; aiState = STATE_TEXT[m.state] || aiState; setStatus(aiState); }
  if (m.type === 'error') { mode = 'error'; $('img').hidden = true; $('msg').hidden = false; $('msg').textContent = m.message; $('title').textContent = '無法顯示'; $('url').textContent = ''; setStatus('無法顯示'); }
  if (m.type === 'end') { ended = true; mode = 'end'; idle('AI 已結束'); }
}

setInterval(() => {
  if (!lastFrameAt || mode === 'end') return;
  const s = Math.round((Date.now() - lastFrameAt) / 1000);
  $('age').textContent = mode === 'same' ? `畫面未變動（${s} 秒）` : `${s} 秒前更新（延遲 +${extraLat}ms，${fps()} fps）`;
}, 500);

$('connect').onclick = () => connect().catch((e) => { dlog('錯誤', e.message || e); idle('錯誤：' + (e.message || e)); });
$('showlog').onclick = async () => {
  const { cg_log = [] } = await chrome.storage.local.get('cg_log');
  $('log').textContent = ['--- 背景程式（host 端）---', ...cg_log, '--- 這個頁面 ---', ...plog].join('\n');
  $('log').hidden = !$('log').hidden;
};
renderRole();
