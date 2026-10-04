// 端對端測試與實驗共用：用本機安裝的 Chrome 開一個全新的設定檔，載入未封裝的插件，並起一個本機網頁伺服器
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function serve(file: string) {
  const body = readFileSync(file);
  const srv = createServer((_, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(body); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/`, close: () => srv.close() };
}

export async function launch(extPath: string, args: string[] = []) {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false, pipe: true, enableExtensions: [extPath], defaultViewport: null,
    userDataDir: mkdtempSync(join(tmpdir(), 'cctabgaze-')),
    args: ['--no-first-run', '--no-default-browser-check', '--window-size=1280,900', ...args],
  });
  const target = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'), { timeout: 15000 });
  const sw = await target.worker();
  if (!sw) throw new Error('背景程式沒有啟動');
  return { browser, sw, id: new URL(target.url()).host };
}
