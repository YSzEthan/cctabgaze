// 觸控手勢狀態機與幾何換算的測試：bun test/gesture.test.ts
import { chunk, diff, SENTINEL as S } from '../web/keys.ts';
import { cancel, clampZoom, down, inside, move, newGesture, norm, pinch, releaseAll, snapZoom, up, wheelDelta, type Action } from '../web/gesture.ts';

let fail = 0;
const eq = (name: string, got: unknown, want: unknown) => { const g = JSON.stringify(got), w = JSON.stringify(want); if (g !== w) { fail++; console.log('FAIL', name, '→', g, '應為', w); } };
const near = (name: string, got: number, want: number, eps = 1e-9) => { if (Math.abs(got - want) > eps) { fail++; console.log('FAIL', name, '→', got, '應為', want); } };
const kinds = (a: Action[]) => a.map((x) => x.k);

// 輕點
{
  const g = newGesture();
  eq('按下不輸出', down(g, 1, 100, 100, 0, true), []);
  eq('輕點 → click n=1', up(g, 1, 80), [{ k: 'click', x: 100, y: 100, n: 1 }]);
  eq('結束後 idle', g.mode, 'idle');
}
// 門檻內的移動仍是點擊（長按沒動也是點擊）
{
  const g = newGesture();
  down(g, 1, 100, 100, 0, true);
  eq('門檻內移動不輸出', move(g, 1, 105, 103, 20), []);
  eq('長按沒移動放開 → click', kinds(up(g, 1, 900)), ['click']);
}
// 連點
{
  const g = newGesture();
  down(g, 1, 100, 100, 0, true); up(g, 1, 50);
  down(g, 1, 105, 102, 150, true);
  eq('第二下 n=2', up(g, 1, 200), [{ k: 'click', x: 105, y: 102, n: 2 }]);
  down(g, 1, 105, 102, 300, true);
  eq('第三下重新計算 n=1', (up(g, 1, 350)[0] as { n: number }).n, 1);
}
{
  const g = newGesture();
  down(g, 1, 100, 100, 0, true); up(g, 1, 50);
  down(g, 1, 100, 100, 500, true);
  eq('超過 300 ms 不算連點', (up(g, 1, 550)[0] as { n: number }).n, 1);
}
{
  const g = newGesture();
  down(g, 1, 100, 100, 0, true); up(g, 1, 50);
  down(g, 1, 200, 100, 100, true);
  eq('距離太遠不算連點', (up(g, 1, 150)[0] as { n: number }).n, 1);
}
// 起點在留白處：不追蹤
{
  const g = newGesture();
  down(g, 1, 5, 5, 0, false);
  eq('留白處按下不追蹤', g.ptrs.size, 0);
  eq('留白處放開沒有輸出', up(g, 1, 50), []);
}
// 捲動：座標固定在起點；累計不遺失；放開時送出剩餘
{
  const g = newGesture();
  down(g, 1, 100, 100, 0, true);
  const first = move(g, 1, 100, 120, 100); // 超過門檻、按得不久 → 捲動，立刻送出
  eq('第一次移動就捲動', first, [{ k: 'wheel', x: 100, y: 100, dx: 0, dy: 20 }]);
  eq('33 ms 內不再送', move(g, 1, 100, 130, 110), []);
  eq('33 ms 內不再送 2', move(g, 1, 100, 140, 120), []);
  const later = move(g, 1, 100, 150, 140);
  eq('節流後送出累計', later, [{ k: 'wheel', x: 100, y: 100, dx: 0, dy: 30 }]);
  move(g, 1, 100, 160, 150);
  eq('放開時送出剩餘', up(g, 1, 160), [{ k: 'wheel', x: 100, y: 100, dx: 0, dy: 10 }]);
  eq('捲動不產生點擊', g.mode, 'idle');
}
{ // 總位移 = 手指位移
  const g = newGesture();
  down(g, 1, 0, 0, 0, true);
  let sum = 0;
  for (let i = 1; i <= 50; i++) for (const a of move(g, 1, 0, i * 3, i * 7)) if (a.k === 'wheel') sum += a.dy;
  for (const a of up(g, 1, 400)) if (a.k === 'wheel') sum += a.dy;
  eq('捲動累計總和等於手指位移', sum, 150);
}
// 長按後拖：起點補 down、move 節流、放開 up
{
  const g = newGesture();
  down(g, 1, 100, 100, 0, true);
  eq('長按後第一次移動：起點 down 再 move', move(g, 1, 100, 130, 600), [{ k: 'down', x: 100, y: 100 }, { k: 'move', x: 100, y: 130 }]);
  eq('move 節流', move(g, 1, 100, 140, 610), []);
  eq('節流後送出', move(g, 1, 100, 150, 650), [{ k: 'move', x: 100, y: 150 }]);
  eq('放開 up 帶最後位置', up(g, 1, 700), [{ k: 'up', x: 100, y: 150 }]);
}
// 雙指：取消進行中的手勢，不產生點擊或捲動
{
  const g = newGesture();
  down(g, 1, 100, 100, 0, true);
  eq('pending 時第二指：沒有輸出', down(g, 2, 200, 100, 50, true), []);
  eq('進入 zoom', g.mode, 'zoom');
  const p = move(g, 2, 300, 100, 80);
  eq('pinch 倍率與中點', p, [{ k: 'pinch', ratio: 2, cx: 200, cy: 100, dx: 50, dy: 0 }]);
  eq('放開一指：仍是 zoom，沒有輸出', up(g, 1, 100), []);
  eq('剩下的手指移動不輸出', move(g, 2, 320, 100, 120), []);
  eq('剩下的手指放開：pinchEnd，不點擊', up(g, 2, 150), [{ k: 'pinchEnd' }]);
  eq('回到 idle', g.mode, 'idle');
}
{ // 拖曳中來了第二指：先放開按鍵
  const g = newGesture();
  down(g, 1, 100, 100, 0, true);
  move(g, 1, 100, 130, 600);
  eq('拖曳中第二指 → up', down(g, 2, 200, 200, 650, true), [{ k: 'up', x: 100, y: 130 }]);
}
{ // 捲動中來了第二指：未送出的累計丟掉
  const g = newGesture();
  down(g, 1, 100, 100, 0, true);
  move(g, 1, 100, 120, 100);
  move(g, 1, 100, 130, 110); // 累計中，還沒送
  eq('捲動中第二指：沒有輸出', down(g, 2, 200, 200, 120, true), []);
  eq('累計已丟掉', [g.accX, g.accY], [0, 0]);
}
// cancel
{
  const g = newGesture();
  down(g, 1, 100, 100, 0, true);
  eq('pending 時 cancel：沒有點擊', cancel(g, 1), []);
  down(g, 1, 100, 100, 1000, true);
  move(g, 1, 100, 130, 1600);
  eq('拖曳中 cancel → up', cancel(g, 1), [{ k: 'up', x: 100, y: 130 }]);
  eq('cancel 後 idle', [g.mode, g.ptrs.size], ['idle', 0]);
}
// releaseAll
{
  const g = newGesture();
  down(g, 1, 100, 100, 0, true);
  move(g, 1, 100, 130, 600);
  eq('releaseAll：拖曳中放開', releaseAll(g), [{ k: 'up', x: 100, y: 130 }]);
  eq('releaseAll：已經 idle 沒有輸出', releaseAll(g), []);
}

// ---- 幾何 ----
// 螢幕 400x800，畫面 1000x500（橫的）→ 顯示 400x200，上下各留 300
const R = { left: 0, top: 0, width: 400, height: 800 };
{
  const p = norm(200, 400, R, 1000, 500)!;
  near('letterbox 中心 x', p.x, 0.5); near('letterbox 中心 y', p.y, 0.5);
  eq('留白在畫面外', inside(norm(200, 100, R, 1000, 500)), false);
  const q = norm(0, 300, R, 1000, 500)!;
  near('左上角', q.x, 0); near('左上角 y', q.y, 0);
  eq('沒有尺寸', norm(1, 1, R, 0, 0), null);
}
{ // 縮放後（元素框被放大 2 倍並平移）座標仍對
  const z = { left: -100, top: -200, width: 800, height: 1600 };
  const p = norm(300, 600, z, 1000, 500)!; // 元素 800 寬、顯示 800x400、上下各留 600
  near('縮放後中心 x', p.x, 0.5); near('縮放後中心 y', p.y, 0.5);
}
// 捲動換算：Retina（截圖 2000 寬、host 可視區 1000 CSS 像素）顯示在 400 寬
near('wheelDelta DPR 2', wheelDelta(40, R, 2000, 1000, 1000), -40 * (1000 / 400));
near('wheelDelta 沒有 vw 時假設 1 倍', wheelDelta(40, R, 1000, 500), -40 * (1000 / 400));
near('wheelDelta 往上滑為正', wheelDelta(-40, R, 1000, 500, 1000), 100);
near('wheelDelta 縮放後（元素 800 寬）', wheelDelta(40, { left: 0, top: 0, width: 800, height: 1600 }, 1000, 500, 1000), -50);
// 縮放變換
const box = { w: 400, h: 800 };
{
  const t = pinch({ s: 1, tx: 0, ty: 0 }, 2, 200, 400, 0, 0, box);
  eq('以中點為中心放大 2 倍', t, { s: 2, tx: -200, ty: -400 });
  near('中點下的內容位置不變', (200 - t.tx) / t.s, 200);
  eq('倍率上限 5', pinch({ s: 4, tx: 0, ty: 0 }, 3, 0, 0, 0, 0, box).s, 5);
  eq('倍率下限 1 且貼齊', pinch({ s: 2, tx: -100, ty: -100 }, 0.1, 200, 400, 0, 0, box), { s: 1, tx: 0, ty: 0 });
  eq('平移不能把畫面拖出可視區', clampZoom({ s: 2, tx: 50, ty: -900 }, box), { s: 2, tx: 0, ty: -800 });
  eq('接近 1 倍時貼齊', snapZoom({ s: 1.03, tx: -5, ty: -5 }), { s: 1, tx: 0, ty: 0 });
  eq('明顯放大不貼齊', snapZoom({ s: 1.5, tx: -5, ty: -5 }).s, 1.5);
}

// ---- 鍵盤：內容與哨兵的差異 ----
eq('沒有變動不送', diff(S), []);
eq('輸入英文', diff(S + 'abc'), [{ k: 'text', text: 'abc' }]);
eq('輸入中文', diff(S + '你好'), [{ k: 'text', text: '你好' }]);
eq('刪除一個字元（Backspace）', diff(S.slice(0, -1)), [{ k: 'back' }]);
eq('空欄位連續刪除', diff(''), [{ k: 'back' }, { k: 'back' }]);
eq('換行', diff(S + 'a\nb'), [{ k: 'text', text: 'a' }, { k: 'enter' }, { k: 'text', text: 'b' }]);
eq('只有換行', diff(S + '\n'), [{ k: 'enter' }]);
eq('CRLF 算一次換行', diff(S + 'a\r\nb').filter((o) => o.k === 'enter').length, 1);
eq('預測候選字一次插入多字元', diff(S + 'hello '), [{ k: 'text', text: 'hello ' }]);
eq('表情符號不被切壞', diff(S + '😀'.repeat(3)), [{ k: 'text', text: '😀😀😀' }]);
{
  const big = diff(S + '字'.repeat(1201));
  eq('長文字每 500 字一段', big.map((o) => o.k === 'text' ? Array.from(o.text).length : 0), [500, 500, 201]);
  eq('跨段不切壞表情符號', diff(S + '😀'.repeat(501)).map((o) => o.k === 'text' ? Array.from(o.text).length : 0), [500, 1]);
}
eq('重複呼叫（內容已重設回哨兵）不重複送', diff(S), []);
eq('貼上：短文字一段', chunk('abc\ndef'), ['abc\ndef']);
eq('貼上：空字串沒有輸出', chunk(''), []);
eq('貼上：長文字分段不切壞表情符號', chunk('😀'.repeat(1001)).map((c) => Array.from(c).length), [500, 500, 1]);

console.log(fail ? `${fail} 項失敗` : '全部通過');
process.exit(fail ? 1 : 0);
