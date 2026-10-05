// 手機鍵盤輸入：隱藏的 textarea 平時固定放哨兵字串。使用者打字、刪除、換行、貼上、預測候選字、自動校正、表情符號，
// 最後都只是「內容和哨兵不一樣了」，所以只比對差異，不依輸入事件的類型分支（手機的事件類型太多）。
// 哨兵讓空欄位按 Backspace 也有東西可刪。純函式，不碰 DOM。
export const SENTINEL = '​​';
export const CHUNK = 500; // host 每筆訊息有長度上限，超過會被靜默丟掉

export type KeyOut = { k: 'back' } | { k: 'enter' } | { k: 'text'; text: string };

export function chunk(text: string): string[] { // 用 Array.from 切才不會切壞表情符號
  const chars = Array.from(text), out: string[] = [];
  for (let i = 0; i < chars.length; i += CHUNK) out.push(chars.slice(i, i + CHUNK).join(''));
  return out;
}

export function diff(value: string, sentinel = SENTINEL): KeyOut[] {
  let p = 0;
  while (p < sentinel.length && p < value.length && value[p] === sentinel[p]) p++;
  const out: KeyOut[] = Array.from({ length: sentinel.length - p }, () => ({ k: 'back' }));
  value.slice(p).split(/\r\n|\r|\n/).forEach((line, i) => {
    if (i) out.push({ k: 'enter' });
    for (const text of chunk(line)) out.push({ k: 'text', text });
  });
  return out;
}
