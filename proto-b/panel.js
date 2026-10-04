const $ = (id) => document.getElementById(id);
const t0 = Date.now();
const log = (...a) => { const line = `[${((Date.now() - t0) / 1000).toFixed(1)}s] ` + a.join(' '); $('log').textContent += line + '\n'; console.log(line); };
const KEY_OFFER = 'tg_offer', KEY_ANSWER = 'tg_answer';
const ls = (k, v) => { try { if (v !== undefined) localStorage.setItem(k, v); return localStorage.getItem(k); } catch { return null; } };
$('role').value = ls('role') || 'host';
$('ip').value = ls('ip') || '';

// 若 candidate 位址被換成 xxxx.local，用這台的 Tailscale IP 取代（備案）
const munge = (sdp, ip) => ip ? sdp.replace(/(a=candidate:\S+ \d+ \w+ \d+ )\S+\.local( \d+ typ)/g, `$1${ip}$2`) : sdp;

function newPc() {
  const pc = new RTCPeerConnection({ iceServers: [] }); // 不用 STUN，只收集本機網卡的 candidate
  pc.onicecandidate = (e) => log(e.candidate ? 'candidate ' + e.candidate.candidate.replace(/^candidate:\S+ /, '') : 'candidate 收集完畢');
  pc.oniceconnectionstatechange = () => log('ice', pc.iceConnectionState);
  pc.onconnectionstatechange = () => { log('connection', pc.connectionState); if (pc.connectionState === 'connected') report(pc); };
  return pc;
}

const gathered = (pc) => new Promise((res) => {
  if (pc.iceGatheringState === 'complete') return res();
  const t = setTimeout(res, 4000);
  pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
});

async function report(pc) {
  const stats = await pc.getStats();
  let pair;
  stats.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId); });
  if (!pair) stats.forEach((r) => { if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) pair = r; });
  if (!pair) return log('找不到選用的 candidate pair');
  const l = stats.get(pair.localCandidateId), r = stats.get(pair.remoteCandidateId);
  log('選用 pair:', `local ${l.candidateType} ${l.address || l.ip}:${l.port}`, '→', `remote ${r.candidateType} ${r.address || r.ip}:${r.port}`);
}

async function host() {
  await chrome.storage.sync.remove([KEY_OFFER, KEY_ANSWER]);
  const pc = newPc();
  const dc = pc.createDataChannel('t');
  dc.onopen = () => {
    log('DataChannel 開啟，開始送 10 筆 30KB 的測試資料（模擬畫面）');
    let n = 0;
    const iv = setInterval(() => {
      if (n >= 10) { clearInterval(iv); log('測試結束'); return; }
      dc.send(JSON.stringify({ n: n, t: Date.now(), pad: 'x'.repeat(30000) }));
      log('送出 #' + n++, 'bufferedAmount', dc.bufferedAmount, '頁面可見性', document.visibilityState);
    }, 1000);
  };
  dc.onmessage = (e) => { const m = JSON.parse(e.data); log(`echo #${m.n} 往返 ${Date.now() - m.t}ms`); };
  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc);
  const sdp = munge(pc.localDescription.sdp, $('ip').value.trim());
  let { deviceId } = await chrome.storage.local.get('deviceId');
  if (!deviceId) { deviceId = crypto.randomUUID(); await chrome.storage.local.set({ deviceId }); }
  await chrome.storage.sync.set({ [KEY_OFFER]: { sdp, t: Date.now(), from: deviceId } });
  log('offer 已寫入 sync（', sdp.length, '位元組），等待 viewer 回應…');
  chrome.storage.onChanged.addListener(async (ch, area) => {
    const a = area === 'sync' && ch[KEY_ANSWER] && ch[KEY_ANSWER].newValue;
    if (!a) return;
    log('收到 answer，sync 延遲約', Date.now() - a.t, 'ms（含兩台時鐘誤差）');
    await pc.setRemoteDescription({ type: 'answer', sdp: a.sdp });
  });
}

async function viewer() {
  log('等待 offer…（請現在到 host 那台按開始）');
  chrome.storage.onChanged.addListener(async (ch, area) => {
    const o = area === 'sync' && ch[KEY_OFFER] && ch[KEY_OFFER].newValue;
    if (!o) return;
    log('收到 offer，sync 延遲約', Date.now() - o.t, 'ms（含兩台時鐘誤差）');
    const pc = newPc();
    pc.ondatachannel = (e) => {
      log('DataChannel 到達');
      e.channel.onmessage = (m) => { const x = JSON.parse(m.data); e.channel.send(JSON.stringify({ n: x.n, t: x.t })); };
    };
    await pc.setRemoteDescription({ type: 'offer', sdp: o.sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered(pc);
    const sdp = munge(pc.localDescription.sdp, $('ip').value.trim());
    await chrome.storage.sync.set({ [KEY_ANSWER]: { sdp, t: Date.now() } });
    log('answer 已寫入 sync');
  });
}

$('start').onclick = () => { ls('role', $('role').value); ls('ip', $('ip').value.trim()); $('start').disabled = true; ($('role').value === 'host' ? host : viewer)().catch((e) => log('錯誤', e.message || e)); };
$('reset').onclick = async () => { await chrome.storage.sync.remove([KEY_OFFER, KEY_ANSWER]); log('已清除 sync 內的 offer / answer'); };

$('bg').onclick = async () => { await chrome.storage.local.set({ headless: true }); log('已啟用背景接收。請關閉所有面板，等 60 秒，再到 host 按開始；之後回來按「顯示背景紀錄」'); };
$('showlog').onclick = async () => { const { tg_log = [] } = await chrome.storage.local.get('tg_log'); $('log').textContent = tg_log.join('\n') || '（背景紀錄是空的）'; };
$('clearlog').onclick = async () => { await chrome.storage.local.remove('tg_log'); $('log').textContent = ''; };
