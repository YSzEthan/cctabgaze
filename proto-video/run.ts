// 實驗：bun proto-video/run.ts
// 1. 權限：沒有人點圖示時 tabCapture 能不能開始（host 沒有人在場，這決定能不能用）
// 2. 編碼：RTCRtpSender 列出的每個視訊編碼各跑一輪，量 fps、延遲、位元率、是否硬體編碼
// 3. 情境：被擷取的分頁在背景、視窗最小化時還有沒有畫面
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, serve, sleep } from '../test/chrome.ts';

const here = import.meta.dirname;
const ext = join(here, 'ext');
const site = await serve(join(here, '../test/fixtures/page.html'));
const SECONDS = Number(process.env.SECONDS || 8), FPS = 60, MAX_BITRATE = 8_000_000;
type Sw = Awaited<ReturnType<typeof launch>>['sw'];
const call = (sw: Sw, fn: string, arg: unknown) => sw.evaluate((fn, arg) => (self as any)[fn](arg), fn, arg) as Promise<any>;
const tabIdOf = (sw: Sw, url: string) => sw.evaluate(async (url) => (await chrome.tabs.query({ url: url + '*' }))[0]!.id!, url);
const out: Record<string, unknown> = { chrome: '', when: new Date().toISOString() };

// ---- 1. 權限 ----
{
  const { browser, sw, id } = await launch(ext);
  out.chrome = await browser.version();
  const page = await browser.newPage();
  await page.goto(site.url);
  const tab = await tabIdOf(sw, site.url);
  const perm: Record<string, unknown> = {};
  perm['沒點圖示'] = await call(sw, 'streamId', tab);
  try {
    const cdp = await browser.target().createCDPSession();
    const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab' }] } as any);
    const tabTarget = targetInfos.find((t) => t.url.startsWith(site.url));
    if (!tabTarget) throw new Error('找不到分頁的 tab target：' + JSON.stringify(targetInfos));
    await cdp.send('Extensions.triggerAction' as any, { id, targetId: tabTarget.targetId });
    await sleep(500);
    perm['點過圖示（模擬）'] = await call(sw, 'streamId', tab);
    const other = await browser.newPage();
    await other.goto(site.url + '?other');
    perm['點過圖示後，另一個沒點過的分頁'] = await call(sw, 'streamId', await tabIdOf(sw, site.url + '?other'));
    await page.bringToFront();
    await page.goto(site.url.replace('127.0.0.1', 'localhost'));
    perm['點過圖示後，同分頁導向別的網站'] = await call(sw, 'streamId', tab);
  } catch (e) { perm['模擬點圖示'] = { error: String(e) }; }
  out['權限（一般啟動）'] = perm;
  await browser.close();
}

// ---- 2、3 用 --allowlisted-extension-id 啟動，不需要點圖示 ----
const { browser, sw, id } = await launch(ext, ['--allowlisted-extension-id=offomejgoflopledfnhhkdldnhfejgjl']);
try {
  const page = await browser.newPage();
  await page.goto(site.url);
  const tab = await tabIdOf(sw, site.url);
  const first = await call(sw, 'streamId', tab);
  out['權限（--allowlisted-extension-id）'] = first.error ? first : { ok: true };
  if (first.error) throw new Error('加了旗標仍無法擷取：' + first.error);
  const px = await page.evaluate(() => ({ width: Math.round(innerWidth * devicePixelRatio), height: Math.round(innerHeight * devicePixelRatio), dpr: devicePixelRatio }));
  out.page = `${px.width}x${px.height}（devicePixelRatio ${px.dpr}）`;

  const run = async (codec: unknown) => {
    const s = await call(sw, 'streamId', tab);
    if (s.error) return { error: s.error };
    return call(sw, 'off', { cmd: 'run', streamId: s.id, codec, seconds: SECONDS, warmup: 3000, fps: FPS, maxBitrate: MAX_BITRATE, width: px.width, height: px.height });
  };
  const caps = await call(sw, 'off', { cmd: 'caps' });
  const codecs: { mimeType: string; sdpFmtpLine?: string }[] = caps.send;
  out['接收端支援的編碼'] = caps.recv.map((c: any) => c.mimeType.replace('video/', '') + (c.sdpFmtpLine ? ' ' + c.sdpFmtpLine : ''));
  const rows: Record<string, unknown>[] = [];
  for (const c of codecs) {
    if (process.env.ONLY && !(c.sdpFmtpLine ?? c.mimeType).includes(process.env.ONLY)) continue;
    const name = c.mimeType.replace('video/', '') + (c.sdpFmtpLine ? ' ' + c.sdpFmtpLine : '');
    const r = await run(c);
    rows.push({ codec: name, ...r });
    console.error(name, JSON.stringify(r));
  }
  out['編碼（分頁在前景）'] = rows;

  // 情境：用硬體編碼裡 fps 最高的那個，沒有硬體編碼就用全部裡最高的
  const ok = rows.filter((r) => !r.error).sort((x, y) => Number(y.uniqueFps) - Number(x.uniqueFps));
  const pickRow = ok.find((r) => r.hwEnc) ?? ok[0];
  const best = codecs.find((c) => pickRow && String(pickRow.codec) === c.mimeType.replace('video/', '') + (c.sdpFmtpLine ? ' ' + c.sdpFmtpLine : ''));
  if (!best) throw new Error('沒有任何編碼成功');
  const scenes: Record<string, unknown> = {};
  const winId = await sw.evaluate(async (t) => (await chrome.tabs.get(t)).windowId, tab);
  const front = await browser.newPage(); // 另開一個分頁蓋在前面
  await front.goto('about:blank');
  await sleep(1000);
  scenes['分頁在背景（同視窗有別的作用中分頁）'] = await run(best);
  await sw.evaluate((w) => chrome.windows.update(w, { state: 'minimized' }), winId);
  await sleep(1500);
  scenes['視窗最小化'] = await run(best);
  await sw.evaluate((w) => chrome.windows.update(w, { state: 'normal' }), winId);
  if (process.env.LOCK) { // 螢幕鎖定沒辦法自動測：LOCK=1 時留 15 秒讓人手動鎖定（Ctrl+Cmd+Q），量完再解鎖看結果
    await page.bringToFront();
    console.error('\n>>> 請在 15 秒內鎖定螢幕（Ctrl+Cmd+Q），大約 30 秒後再解鎖 <<<\n');
    await sleep(15000);
    scenes['螢幕鎖定'] = await run(best);
  }
  out['情境（' + best?.mimeType + ' ' + (best?.sdpFmtpLine ?? '') + '）'] = scenes;
  console.error(JSON.stringify(scenes));
} finally {
  await browser.close();
  site.close();
}
if (!process.env.ONLY) writeFileSync(join(here, 'results.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
