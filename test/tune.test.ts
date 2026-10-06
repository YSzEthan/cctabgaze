// 畫面設定的驗證與合併：bun test/tune.test.ts
import { DEFAULT_TUNE, parseTune, TUNE_OPTIONS } from '../src/tune.ts';

let fail = 0;
const eq = (name: string, got: unknown, want: unknown) => { const g = JSON.stringify(got), w = JSON.stringify(want); if (g !== w) { fail++; console.log('FAIL', name, '→', g, '應為', w); } };

eq('預設值都在選項內', parseTune(DEFAULT_TUNE), DEFAULT_TUNE);
eq('完整的合法設定原樣通過', parseTune({ quality: 90, fast: 40, format: 'png', mode: 'image' }), { quality: 90, fast: 40, format: 'png', mode: 'image' });
eq('缺的欄位回到預設（整筆覆蓋）', parseTune({ mode: 'image' }), { ...DEFAULT_TUNE, mode: 'image' });
eq('不在選項內的值回到預設', parseTune({ quality: 91, fast: 7, format: 'gif', mode: 'x' }), DEFAULT_TUNE);
eq('型別不對（字串 90）不接受', parseTune({ quality: '90' }), DEFAULT_TUNE);
eq('原型鏈上的鍵不會被當成值', parseTune({ quality: '__proto__', mode: 'constructor' }), DEFAULT_TUNE);
for (const raw of [null, undefined, 42, 'x', [], [1, 2]]) eq('非物件輸入 ' + JSON.stringify(raw), parseTune(raw), DEFAULT_TUNE);
for (const k of Object.keys(TUNE_OPTIONS) as (keyof typeof TUNE_OPTIONS)[]) {
  const values = TUNE_OPTIONS[k].map((o) => o.value);
  eq(`選項 ${k} 沒有重複`, new Set(values).size, values.length);
  eq(`每個 ${k} 選項都能通過驗證`, values.every((v) => parseTune({ ...DEFAULT_TUNE, [k]: v })[k] === v), true);
}

console.log(fail ? `${fail} 項失敗` : '全部通過');
process.exit(fail ? 1 : 0);
