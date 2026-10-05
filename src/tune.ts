// 畫面設定的預設值與可選項：host 的白名單、插件的懸浮視窗、手機網頁共用這一份（不依賴 chrome，web/ 也會 import）
import type { Format, Mode, Tune } from './protocol.ts';

// fast：畫面有變化時，上一張送達後最短隔多少毫秒再截下一張（0＝不限）
export const DEFAULT_TUNE: Tune = { quality: 50, fast: 0, format: 'jpeg', mode: 'video' };

interface Opt<T> { value: T; label: string }
export const TUNE_OPTIONS: { [K in keyof Tune]: readonly Opt<Tune[K]>[] } = {
  mode: [{ value: 'video' satisfies Mode, label: '視訊（H264，預設）' }, { value: 'image' satisfies Mode, label: '圖片（逐張 JPEG，備案）' }],
  quality: [{ value: 30, label: '低（30）' }, { value: 50, label: '標準（50）' }, { value: 75, label: '高（75）' }, { value: 90, label: '最高（90）' }],
  fast: [{ value: 200, label: '上限 5 fps' }, { value: 100, label: '上限 10 fps' }, { value: 66, label: '上限 15 fps' }, { value: 40, label: '上限 25 fps' }, { value: 0, label: '不限' }],
  format: [{ value: 'jpeg' satisfies Format, label: 'JPEG' }, { value: 'webp' satisfies Format, label: 'WebP' }, { value: 'png' satisfies Format, label: 'PNG（無損，檔案大、較慢）' }],
};

// 不可信的輸入（viewer 經 DataChannel 送來的、localStorage 讀出來的）→ 完整的 Tune：每個欄位都必須在選項內，否則用預設。整筆覆蓋，缺的欄位回到預設
export function parseTune(raw: unknown): Tune {
  const r = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
  const pick = <K extends keyof Tune>(k: K): Tune[K] => (TUNE_OPTIONS[k].find((o) => o.value === r[k])?.value ?? DEFAULT_TUNE[k]);
  return { quality: pick('quality'), fast: pick('fast'), format: pick('format'), mode: pick('mode') };
}
