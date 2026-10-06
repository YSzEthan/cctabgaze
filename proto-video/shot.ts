// 實驗：bun proto-video/shot.ts
// 擷取仍用 debugger 連續截圖（不需要點圖示、不需要啟動旗標），但不再一張張送圖片，
// 而是把截圖餵進視訊編碼器、走 WebRTC 視訊軌。量這樣能到幾 fps、延遲多少、省多少頻寬。
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, serve, sleep } from '../test/chrome.ts';

const here = import.meta.dirname;
const site = await serve(join(here, '../test/fixtures/page.html'));
const SECONDS = Number(process.env.SECONDS || 8);
const locked = () => /CGSSessionScreenIsLocked"?\s*=\s*Yes/.test(execSync('ioreg -n Root -d1').toString());
const { browser, sw } = await launch(join(here, 'ext')); // 一般啟動，沒有任何旗標
const call = (fn: string, arg?: unknown) => sw.evaluate((fn, arg) => (self as any)[fn](arg), fn, arg) as Promise<any>;
const out: Record<string, unknown> = { chrome: await browser.version(), when: new Date().toISOString(), 螢幕鎖定: locked() };
try {
  const page = await browser.newPage();
  await page.goto(site.url);
  const tabId = await sw.evaluate(async (url) => (await chrome.tabs.query({ url: url + '*' }))[0]!.id!, site.url);
  out.page = await page.evaluate(() => `${Math.round(innerWidth * devicePixelRatio)}x${Math.round(innerHeight * devicePixelRatio)}（devicePixelRatio ${devicePixelRatio}）`);
  const codecs: { mimeType: string; sdpFmtpLine?: string }[] = (await call('off', { cmd: 'caps' })).send;
  const codec = (mime: string, fmtp = '') => codecs.find((c) => c.mimeType === 'video/' + mime && (c.sdpFmtpLine ?? '').includes(fmtp));
  const H264 = codec('H264', 'packetization-mode=1;profile-level-id=640034'), VP8 = codec('VP8'), H265 = codec('H265');

  const run = async (name: string, format: string, quality: number, c: typeof H264) => {
    if (!c || (process.env.ONLY && !name.includes(process.env.ONLY))) return;
    await call('shotStart', { tabId, format, quality });
    const r = await call('off', { cmd: 'shotrun', codec: c, seconds: SECONDS, warmup: 3000, fps: 60, maxBitrate: 8_000_000 });
    const s = await call('shotStop');
    const row = { name, ...r, ...(s.error && { shotError: s.error }) };
    (out.rows as unknown[]).push(row);
    console.error(JSON.stringify(row));
  };
  out.rows = [];
  await run('JPEG 50 → H264 硬體', 'jpeg', 50, H264);
  await run('JPEG 90 → H264 硬體', 'jpeg', 90, H264);
  await run('PNG → H264 硬體', 'png', 0, H264);
  await run('WebP 90 → H264 硬體', 'webp', 90, H264);
  await run('JPEG 90 → H265 硬體', 'jpeg', 90, H265);
  await run('JPEG 90 → VP8 軟體', 'jpeg', 90, VP8);
  const front = await browser.newPage(); // 被截的分頁退到背景
  await front.goto('about:blank');
  await sleep(1000);
  await run('JPEG 90 → H264 硬體（分頁在背景）', 'jpeg', 90, H264);
  out.螢幕鎖定結束時 = locked();
} finally {
  await browser.close();
  site.close();
}
if (!process.env.ONLY) writeFileSync(join(here, 'results-shot.json'), JSON.stringify(out, null, 2));
