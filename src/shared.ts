// 背景程式裡 host 與 viewer 兩邊共用的東西
export const REQ = 'cg_req', RES = 'cg_res';

// ---- 診斷紀錄（viewer 頁面可顯示）----
let q: Promise<void> = Promise.resolve();
export const slog = (...a: unknown[]) => { q = q.then(async () => {
  const line = `[${new Date().toISOString().slice(11, 23)}] ` + a.join(' ');
  const { cg_log = [] } = await chrome.storage.local.get<{ cg_log: string[] }>('cg_log');
  cg_log.push(line);
  await chrome.storage.local.set({ cg_log: cg_log.slice(-300) });
}).catch(() => {}); return q; }; // 寫入失敗一次不能讓之後所有紀錄都不寫

export async function ensureOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (!ctx.length) await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['WEB_RTC'], justification: '與另一台電腦的 Chrome 建立 WebRTC 連線傳送畫面' });
}

export const errText = (e: unknown) => (e instanceof Error && e.message) || String(e);
