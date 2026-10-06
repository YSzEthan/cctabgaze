// 位址與網段解析的測試：bun test/rtc.test.ts（Bun 直接執行 TypeScript，不需要先編譯）
import { checkPair, inNets, keepAllowed, netsOrDefault, parseCidr, parseIp, parseNets } from '../src/rtc.ts';

let fail = 0;
const eq = (name: string, got: unknown, want: unknown) => { if (got !== want) { fail++; console.log('FAIL', name, '→', got, '應為', want); } };
const J = JSON.stringify;

// parseIp：合法與不合法
for (const s of ['100.64.0.1', '0.0.0.0', '255.255.255.255', '::', '::1', 'fd7a:115c:a1e0::1', 'fd7a:115c:a1e0:ab12:1:2:3:4', '1:2:3:4:5:6:7:8', '1::8', '1:2:3:4:5:6:7::', 'FD7A:115C:A1E0::1'])
  eq('parseIp ok ' + s, !!parseIp(s), true);
for (const s of ['', 'abc', '100.64.0', '100.64.0.1.evil.com', '100.64.0.256', '100.064.0.1', '01.2.3.4', '1.2.3.4 ', '100.64.0.1\n', '::ffff:100.64.0.1', 'fe80::1%en0', '[::1]', '1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8:9', '1::2::3', ':::', ':1:2:3:4:5:6:7', 'g::1', '12345::1', 'host.local', 12, null, undefined])
  eq('parseIp bad ' + J(s), !!parseIp(s), false);

// parseCidr
for (const s of ['100.64.0.0/10', '0.0.0.0/0', '1.2.3.4/32', 'fd7a:115c:a1e0::/48', '::/0', '::1/128', '100.64.0.1/10', ' 10.0.0.0/8 '])
  eq('parseCidr ok ' + s, !!parseCidr(s), true);
for (const s of ['100.64.0.0', '100.64.0.0/', '100.64.0.0/33', '::/129', '100.64.0.0/010', 'abc/8', '/8', '10.0.0.0/8/8', '10.0.0.0 /8', ''])
  eq('parseCidr bad ' + J(s), !!parseCidr(s), false);

// inNets：預設網段
const D = netsOrDefault(null);
const cases: [string, boolean][] = [['100.64.0.0', true], ['100.127.255.255', true], ['100.63.255.255', false], ['100.128.0.0', false], ['100.96.126.135', true], ['100.106.196.36', true], ['100.67.27.25', true],
  ['192.168.1.5', false], ['10.0.0.1', false], ['8.8.8.8', false], ['fd7a:115c:a1e0::1', true], ['fd7a:115c:a1e0:ffff:ffff:ffff:ffff:ffff', true], ['fd7a:115c:a1e1::1', false], ['::1', false],
  ['100.64.0.1.evil.com', false], ['example.local', false], ['::ffff:100.64.0.1', false], ['', false]];
for (const [a, want] of cases) eq('inNets default ' + a, inNets(a, D), want);
eq('inNets 自訂 /8', inNets('10.1.2.3', parseNets(['10.0.0.0/8']).nets), true);
eq('inNets 自訂 /8 排除', inNets('11.1.2.3', parseNets(['10.0.0.0/8']).nets), false);
eq('inNets /0 全過 v4', inNets('8.8.8.8', parseNets(['0.0.0.0/0']).nets), true);
eq('inNets /0 不跨族', inNets('::1', parseNets(['0.0.0.0/0']).nets), false);
eq('inNets /32', inNets('1.2.3.4', parseNets(['1.2.3.4/32']).nets), true);
eq('inNets /32 鄰居', inNets('1.2.3.5', parseNets(['1.2.3.4/32']).nets), false);
eq('inNets 主機位元遮罩', inNets('100.64.9.9', parseNets(['100.64.0.1/10']).nets), true);

// netsOrDefault / parseNets
eq('空清單還原預設', netsOrDefault([]).length, 2);
eq('全壞還原預設', netsOrDefault(['abc']).length, 2);
eq('非陣列還原預設', netsOrDefault('x').length, 2);
eq('parseNets 錯誤行號', J(parseNets(['10.0.0.0/8', '', 'bad', '1.2.3.4/99']).errors.map((e) => e.line)), '[3,4]');

// keepAllowed
const sdp = ['v=0', 'c=IN IP4 192.168.1.5', 'a=candidate:1 1 udp 2113937151 100.67.27.25 5000 typ host generation 0',
  'a=candidate:2 1 udp 2113937151 192.168.1.5 5001 typ host generation 0', 'a=candidate:3 1 udp 1 100.64.0.1.evil.com 5002 typ host',
  'a=candidate:4 1 udp 1 100.67.27.25 5003 typ srflx raddr 0.0.0.0 rport 0', 'a=candidate:5 1 tcp 1 fd7a:115c:a1e0::1 9 typ host tcptype active', 'c=IN IP6 fe80::1', 'a=end-of-candidates', ''].join('\r\n');
const k = keepAllowed(sdp, D);
eq('keepAllowed 保留數', k.kept, 2);
eq('keepAllowed 保留 Tailscale host', k.sdp.includes('100.67.27.25 5000'), true);
eq('keepAllowed 保留 IPv6 tcp', k.sdp.includes('fd7a:115c:a1e0::1 9'), true);
eq('keepAllowed 丟區網', k.sdp.includes('192.168.1.5 5001'), false);
eq('keepAllowed 丟主機名', k.sdp.includes('evil.com'), false);
eq('keepAllowed 丟 srflx', k.sdp.includes('5003'), false);
eq('keepAllowed c= 不洩漏', k.sdp.includes('c=IN IP4 0.0.0.0') && !k.sdp.includes('192.168.1.5\r\n') && k.sdp.includes('c=IN IP6 ::'), true);
eq('keepAllowed 保留結尾換行', k.sdp.endsWith('a=end-of-candidates\r\n'), true);
// 只用 LF 換行的 SDP 不能繞過過濾
const lf = sdp.replace(/\r\n/g, '\n');
eq('LF 換行一樣過濾', keepAllowed(lf, D).kept, 2);
eq('LF 換行丟區網', keepAllowed(lf, D).sdp.includes('192.168.1.5 5001'), false);

// checkPair：用假的 RTCPeerConnection 餵 getStats
const fakePc = (local?: string, remote?: string) => ({ getStats: async () => {
  const m = new Map<string, any>([['t', { type: 'transport', selectedCandidatePairId: 'p' }], ['p', { localCandidateId: 'l', remoteCandidateId: 'r' }], ['l', local ? { address: local } : {}], ['r', remote ? { address: remote } : {}]]);
  return m; // Map 的 forEach 和 get 剛好和 RTCStatsReport 用法相同（forEach 的參數是 value）
} }) as unknown as RTCPeerConnection;
eq('checkPair 兩端都在網段', (await checkPair(fakePc('100.100.1.1', '100.101.2.2'), D)).ok, true);
eq('checkPair 對方在網段外', (await checkPair(fakePc('100.100.1.1', '192.168.0.15'), D)).ok, false);
eq('checkPair 本機在網段外', (await checkPair(fakePc('192.168.0.15', '100.101.2.2'), D)).ok, false);
eq('checkPair 對方位址讀不到：嚴格模式不通過', (await checkPair(fakePc('100.100.1.1'), D)).ok, false);
eq('checkPair 對方位址讀不到：lax 只看本機，通過', (await checkPair(fakePc('100.100.1.1'), D, true)).ok, true);
eq('checkPair 對方位址讀不到：lax 本機在網段外，不通過', (await checkPair(fakePc('192.168.0.15'), D, true)).ok, false);
eq('checkPair 對方位址讀得到但在網段外：lax 也不通過', (await checkPair(fakePc('100.100.1.1', '192.168.0.15'), D, true)).ok, false);
eq('checkPair 兩端都讀不到：lax 不通過', (await checkPair(fakePc(), D, true)).ok, false);

console.log(fail ?  `${fail} 項失敗` : '全部通過');
process.exit(fail ? 1 : 0);
