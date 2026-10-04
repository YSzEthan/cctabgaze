// 位址與網段解析的測試：node test/rtc.test.js（rtc.js 是瀏覽器腳本，這裡用 vm 載入）
const fs = require('fs'), vm = require('vm'), path = require('path');
const ctx = vm.createContext({ console, setTimeout });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/rtc.js'), 'utf8'), ctx);
const run = (code) => vm.runInContext(code, ctx);
let fail = 0;
const eq = (name, got, want) => { if (got !== want) { fail++; console.log('FAIL', name, '→', got, '應為', want); } };
const J = JSON.stringify;

// parseIp：合法與不合法
for (const s of ['100.64.0.1', '0.0.0.0', '255.255.255.255', '::', '::1', 'fd7a:115c:a1e0::1', 'fd7a:115c:a1e0:ab12:1:2:3:4', '1:2:3:4:5:6:7:8', '1::8', '1:2:3:4:5:6:7::', 'FD7A:115C:A1E0::1'])
  eq('parseIp ok ' + s, run(`!!parseIp(${J(s)})`), true);
for (const s of ['', 'abc', '100.64.0', '100.64.0.1.evil.com', '100.64.0.256', '100.064.0.1', '01.2.3.4', '1.2.3.4 ', '100.64.0.1\n', '::ffff:100.64.0.1', 'fe80::1%en0', '[::1]', '1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8:9', '1::2::3', ':::', ':1:2:3:4:5:6:7', 'g::1', '12345::1', 'host.local', 12, null, undefined])
  eq('parseIp bad ' + J(s), run(`!!parseIp(${J(s === undefined ? null : s)})`), false);

// parseCidr
for (const s of ['100.64.0.0/10', '0.0.0.0/0', '1.2.3.4/32', 'fd7a:115c:a1e0::/48', '::/0', '::1/128', '100.64.0.1/10', ' 10.0.0.0/8 '])
  eq('parseCidr ok ' + s, run(`!!parseCidr(${J(s)})`), true);
for (const s of ['100.64.0.0', '100.64.0.0/', '100.64.0.0/33', '::/129', '100.64.0.0/010', 'abc/8', '/8', '10.0.0.0/8/8', '10.0.0.0 /8', ''])
  eq('parseCidr bad ' + J(s), run(`!!parseCidr(${J(s)})`), false);

// inNets：預設網段
const D = 'netsOrDefault(null)';
for (const [a, want] of [['100.64.0.0', true], ['100.127.255.255', true], ['100.63.255.255', false], ['100.128.0.0', false], ['100.96.126.135', true], ['100.106.196.36', true], ['100.67.27.25', true],
  ['192.168.1.5', false], ['10.0.0.1', false], ['8.8.8.8', false], ['fd7a:115c:a1e0::1', true], ['fd7a:115c:a1e0:ffff:ffff:ffff:ffff:ffff', true], ['fd7a:115c:a1e1::1', false], ['::1', false],
  ['100.64.0.1.evil.com', false], ['example.local', false], ['::ffff:100.64.0.1', false], ['', false]])
  eq('inNets default ' + a, run(`inNets(${J(a)}, ${D})`), want);
eq('inNets 自訂 /8', run(`inNets('10.1.2.3', parseNets(['10.0.0.0/8']).nets)`), true);
eq('inNets 自訂 /8 排除', run(`inNets('11.1.2.3', parseNets(['10.0.0.0/8']).nets)`), false);
eq('inNets /0 全過 v4', run(`inNets('8.8.8.8', parseNets(['0.0.0.0/0']).nets)`), true);
eq('inNets /0 不跨族', run(`inNets('::1', parseNets(['0.0.0.0/0']).nets)`), false);
eq('inNets /32', run(`inNets('1.2.3.4', parseNets(['1.2.3.4/32']).nets)`), true);
eq('inNets /32 鄰居', run(`inNets('1.2.3.5', parseNets(['1.2.3.4/32']).nets)`), false);
eq('inNets 主機位元遮罩', run(`inNets('100.64.9.9', parseNets(['100.64.0.1/10']).nets)`), true);

// netsOrDefault / parseNets
eq('空清單還原預設', run(`netsOrDefault([]).length`), 2);
eq('全壞還原預設', run(`netsOrDefault(['abc']).length`), 2);
eq('非陣列還原預設', run(`netsOrDefault('x').length`), 2);
eq('parseNets 錯誤行號', run(`J = JSON.stringify; J(parseNets(['10.0.0.0/8', '', 'bad', '1.2.3.4/99']).errors.map(e => e.line))`), '[3,4]');

// keepAllowed
const sdp = ['v=0', 'c=IN IP4 192.168.1.5', 'a=candidate:1 1 udp 2113937151 100.67.27.25 5000 typ host generation 0',
  'a=candidate:2 1 udp 2113937151 192.168.1.5 5001 typ host generation 0', 'a=candidate:3 1 udp 1 100.64.0.1.evil.com 5002 typ host',
  'a=candidate:4 1 udp 1 100.67.27.25 5003 typ srflx raddr 0.0.0.0 rport 0', 'a=candidate:5 1 tcp 1 fd7a:115c:a1e0::1 9 typ host tcptype active', 'c=IN IP6 fe80::1', 'a=end-of-candidates', ''].join('\r\n');
const k = run(`keepAllowed(${J(sdp)}, ${D})`);
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
eq('LF 換行一樣過濾', run(`keepAllowed(${J(lf)}, ${D})`).kept, 2);
eq('LF 換行丟區網', run(`keepAllowed(${J(lf)}, ${D})`).sdp.includes('192.168.1.5 5001'), false);

console.log(fail ? `${fail} 項失敗` : '全部通過');
process.exit(fail ? 1 : 0);
