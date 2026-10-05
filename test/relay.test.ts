// 信令中繼邏輯的測試：node test/relay.test.ts
import { Relay, type Answer, type Sock } from '../server/relay.ts';

let fail = 0;
const eq = (name: string, got: unknown, want: unknown) => { const g = JSON.stringify(got), w = JSON.stringify(want); if (g !== w) { fail++; console.log('FAIL', name, '→', g, '應為', w); } };
const sock = () => { const s = { sent: [] as string[], closed: false, send(d: string) { s.sent.push(d); }, close() { s.closed = true; } }; return s satisfies Sock & { sent: string[]; closed: boolean }; };
const lastId = (s: { sent: string[] }) => JSON.parse(s.sent.at(-1) ?? '{}').id as string;

// 沒有 host
eq('沒有 host', await new Relay().offer('x'), { error: 'host-offline' });

// 正常來回
{
  const r = new Relay(), h = sock();
  r.attach(h);
  const p = r.offer('OFFER');
  eq('offer 轉給 host', JSON.parse(h.sent[0]!).sdp, 'OFFER');
  r.fromHost(h, JSON.stringify({ type: 'answer', id: lastId(h), sdp: 'ANSWER' }));
  eq('answer 回傳', await p, { sdp: 'ANSWER' });
  eq('等待表清空', r.waiting.size, 0);
}

// host 回 error
{
  const r = new Relay(), h = sock();
  r.attach(h);
  const p = r.offer('x');
  r.fromHost(h, JSON.stringify({ type: 'error', id: lastId(h), error: 'ai-idle' }));
  eq('error 回傳', await p, { error: 'ai-idle' });
}

// 逾時
{
  const r = new Relay(30), h = sock();
  r.attach(h);
  eq('逾時', await r.offer('x'), { error: 'timeout' });
  eq('逾時後等待表清空', r.waiting.size, 0);
}

// 別人的 answer、錯的 id、壞 JSON 都不能動到等待中的 offer
{
  const r = new Relay(40), h = sock(), evil = sock();
  r.attach(h);
  const p = r.offer('x');
  const id = lastId(h);
  r.fromHost(evil, JSON.stringify({ type: 'answer', id, sdp: 'EVIL' }));
  r.fromHost(h, JSON.stringify({ type: 'answer', id: 'other', sdp: 'X' }));
  r.fromHost(h, 'not json');
  eq('不合法的回覆都忽略後逾時', await p, { error: 'timeout' });
}

// host 自己送出內容不合法的 answer：立刻失敗，不讓 viewer 乾等
{
  const r = new Relay(), h = sock();
  r.attach(h);
  const p = r.offer('x');
  r.fromHost(h, JSON.stringify({ type: 'answer', id: lastId(h), sdp: 123 }));
  eq('answer 內容不合法', await p, { error: 'failed' });
}

// host 斷線：等待中的 offer 立刻失敗
{
  const r = new Relay(), h = sock();
  r.attach(h);
  const p = r.offer('x');
  r.detach(h);
  eq('host 斷線', await p, { error: 'host-offline' });
  eq('斷線後沒有 host', await r.offer('y'), { error: 'host-offline' });
}

// 新 host 取代舊的：舊的被關閉、等待中的 offer 失敗；舊的再斷線不能動到新的
{
  const r = new Relay(), a = sock(), b = sock();
  r.attach(a);
  const p = r.offer('x');
  r.attach(b);
  eq('舊 host 被關閉', a.closed, true);
  eq('被取代時等待中的 offer 失敗', await p, { error: 'host-restarted' });
  r.detach(a);
  const q = r.offer('y');
  eq('舊連線斷線不影響新 host', JSON.parse(b.sent[0]!).sdp, 'y');
  r.fromHost(b, JSON.stringify({ type: 'answer', id: lastId(b), sdp: 'Z' }));
  eq('新 host 正常運作', await q, { sdp: 'Z' } satisfies Answer);
}

// ping → pong；非 host 的連線不回
{
  const r = new Relay(), h = sock(), o = sock();
  r.attach(h);
  r.fromHost(h, '{"type":"ping"}');
  r.fromHost(o, '{"type":"ping"}');
  eq('ping 回 pong', h.sent, ['{"type":"pong"}']);
  eq('非 host 不回', o.sent, []);
}

console.log(fail ? `${fail} 項失敗` : '全部通過');
process.exit(fail ? 1 : 0);
