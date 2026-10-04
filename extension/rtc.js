// viewer 與 host 共用：只保留 Tailscale 位址的 candidate、等候 candidate 收集完成
const TS4 = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./; // 100.64.0.0/10
const TS6 = /^fd7a:115c:a1e0:/i;
const isTailscale = (ip) => TS4.test(ip) || TS6.test(ip);

function keepTailscaleOnly(sdp) {
  let kept = 0;
  const out = sdp.split('\r\n').filter((l) => {
    if (!l.startsWith('a=candidate:')) return true;
    if (!isTailscale(l.split(' ')[4])) return false;
    kept++;
    return true;
  });
  return { sdp: out.join('\r\n'), kept };
}

const gathered = (p) => new Promise((res) => {
  if (p.iceGatheringState === 'complete') return res();
  const t = setTimeout(res, 4000);
  p.addEventListener('icegatheringstatechange', () => { if (p.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
});
