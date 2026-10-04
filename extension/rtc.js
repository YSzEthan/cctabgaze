// viewer 與 host 共用：位址與網段比對、只保留允許網段的 candidate、連上後檢查實際位址、等候 candidate 收集完成。
// 位址一律要是乾淨的 IP 字面值：主機名、.local、方括號、zone id、IPv4-mapped IPv6 都直接拒絕，不做對映。
const DEFAULT_NETS = ['100.64.0.0/10', 'fd7a:115c:a1e0::/48']; // Tailscale（NetBird 的 100.96.x.x 也落在第一段）

function parseIp(s) { // → { fam, bits, n(BigInt) } 或 null
  if (typeof s !== 'string') return null;
  if (/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(s)) {
    const p = s.split('.').map(Number);
    if (p.some((x) => x > 255)) return null;
    return { fam: 4, bits: 32, n: p.reduce((a, x) => (a << 8n) | BigInt(x), 0n) };
  }
  if (!s.includes(':') || !/^[0-9a-f:]+$/i.test(s)) return null;
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const groups = (h) => (h === '' ? [] : h.split(':'));
  const head = groups(halves[0]), tail = halves.length === 2 ? groups(halves[1]) : [];
  const all = [...head, ...tail];
  if (all.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  if (halves.length === 1 ? all.length !== 8 : all.length > 7) return null; // :: 至少代表一組零
  const full = [...head, ...Array(8 - all.length).fill('0'), ...tail];
  return { fam: 6, bits: 128, n: full.reduce((a, g) => (a << 16n) | BigInt(parseInt(g, 16)), 0n) };
}

function parseCidr(s) { // 前綴必填；帶主機位元的寫法（100.64.0.1/10）接受並遮罩
  const m = typeof s === 'string' && s.trim().match(/^([^/\s]+)\/(0|[1-9]\d{0,2})$/);
  const ip = m && parseIp(m[1]);
  if (!ip || Number(m[2]) > ip.bits) return null;
  const len = Number(m[2]), shift = BigInt(ip.bits - len);
  return { fam: ip.fam, bits: ip.bits, len, n: (ip.n >> shift) << shift };
}

function parseNets(lines) { // → { nets, errors: [{ line, text }] }，空行略過
  const nets = [], errors = [];
  lines.forEach((text, i) => {
    if (!String(text).trim()) return;
    const n = parseCidr(text);
    if (n) nets.push(n); else errors.push({ line: i + 1, text });
  });
  return { nets, errors };
}
const netsOrDefault = (raw) => { // 沒設定或全是壞的：還原預設，不要有第三種狀態
  const { nets } = parseNets(Array.isArray(raw) ? raw : []);
  return nets.length ? nets : parseNets(DEFAULT_NETS).nets;
};

function inNets(addr, nets) {
  const ip = parseIp(addr);
  return !!ip && nets.some((n) => n.fam === ip.fam && (ip.n >> BigInt(n.bits - n.len)) === (n.n >> BigInt(n.bits - n.len)));
}

function keepAllowed(sdp, nets) { // 只留 typ host 且位址在允許網段內的 candidate；c= 行不洩漏位址
  let kept = 0;
  const out = [];
  for (const l of sdp.split(/\r?\n/)) {
    if (l.startsWith('a=candidate:')) {
      const f = l.split(' ');
      if (f[6] !== 'typ' || f[7] !== 'host' || !inNets(f[4], nets)) continue;
      kept++;
    }
    out.push(l.replace(/^c=IN IP4 .*/, 'c=IN IP4 0.0.0.0').replace(/^c=IN IP6 .*/, 'c=IN IP6 ::'));
  }
  return { sdp: out.join('\r\n'), kept };
}

// 連上後讀實際選用的 pair。過濾的只是 SDP 文字，這是 socket 層的檢查；位址讀不到（例如被遮蔽的 prflx）一律算不通過
async function checkPair(pc, nets) {
  for (let i = 0; i < 5; i++) {
    const stats = await pc.getStats();
    let pair = null;
    stats.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId); });
    const l = pair && stats.get(pair.localCandidateId), x = pair && stats.get(pair.remoteCandidateId);
    const local = l && (l.address ?? l.ip), remote = x && (x.address ?? x.ip);
    if (local && remote) return { ok: inNets(local, nets) && inNets(remote, nets), local, remote };
    await new Promise((r) => setTimeout(r, 200)); // 剛連上時 stats 可能還沒填好
  }
  return { ok: false };
}

const gathered = (p) => new Promise((res) => {
  if (p.iceGatheringState === 'complete') return res();
  const t = setTimeout(res, 4000);
  p.addEventListener('icegatheringstatechange', () => { if (p.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
});
