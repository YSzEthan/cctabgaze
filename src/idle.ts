// offscreen 文件裡 host 與 viewer 兩條連線共用：都沒了，才請背景程式把這個 offscreen 文件關掉
const busy: (() => boolean)[] = [];
export const keepsAlive = (f: () => boolean) => { busy.push(f); };
export function idleCheck() {
  setTimeout(() => { if (!busy.some((f) => f())) chrome.runtime.sendMessage({ target: 'sw', type: 'idle' }).catch(() => {}); }, 1500);
}
