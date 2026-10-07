// 端對端測試：bun run e2e。在同一個 Chrome 裡讓插件自己連自己：
// 建一個標題是 Claude 的分頁群組當成 AI 的分頁，觸發 viewer 連線，依序確認
// 視訊模式、輸入、切換成圖片模式再切回、靜止頁面、連續重連、結束連線。
// 握手走 storage.sync（沒登入時只在本機生效），畫面走真的 WebRTC。
import { join } from 'node:path';
import type { Page } from 'puppeteer-core';
import { launch, serve, sleep } from './chrome.ts';

const root = join(import.meta.dirname, '..');
const site = await serve(join(import.meta.dirname, 'fixtures/page.html'));
const { browser, sw, id } = await launch(join(root, 'extension'));
let fail = 0;
const ok = (name: string, pass: boolean, detail: unknown = '') => { if (!pass) fail++; console.log(pass ? 'ok  ' : 'FAIL', name, detail); };
const until = async <T>(what: string, f: () => Promise<T>, ms = 20000): Promise<NonNullable<T>> => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) { const v = await f().catch(() => null); if (v) return v; }
  throw new Error('等不到：' + what);
};
const errors: string[] = [];
browser.on('targetcreated', async (t) => { const p = await t.page().catch(() => null); p?.on('pageerror', (e) => errors.push(String(e))); });
const hostLog = () => sw.evaluate(async () => ((await chrome.storage.local.get('cg_log')).cg_log as string[]).join('\n'));

// 在檢視頁量 ms 毫秒：fps，以及讀畫面最上面的條碼（見 fixtures/page.html）算出的延遲
const probe = (viewer: Page, el: 'img' | 'vid', ms: number) => viewer.evaluate((el, ms) => new Promise<{ fps: number; p50: number; p95: number; n: number }>((done) => {
  const node = document.getElementById(el) as HTMLImageElement & HTMLVideoElement, cx = new OffscreenCanvas(340, 1).getContext('2d')!, lats: number[] = [];
  let n = 0, on = true;
  const read = () => {
    n++;
    const w = el === 'vid' ? node.videoWidth : node.naturalWidth, h = el === 'vid' ? node.videoHeight : node.naturalHeight;
    if (!w) return;
    cx.drawImage(node, 0, h * 0.01, w, h * 0.02, 0, 0, 340, 1);
    const d = cx.getImageData(0, 0, 340, 1).data, bit = (i: number) => d[(i * 10 + 5) * 4]! < 128;
    if (bit(0) || !bit(1)) return;
    let v = 0;
    for (let i = 2; i < 34; i++) v = v * 2 + (bit(i) ? 1 : 0);
    const lat = (Date.now() % 2 ** 32) - v;
    if (lat >= 0 && lat < 5000) lats.push(lat);
  };
  const tick = () => { if (!on) return; read(); node.requestVideoFrameCallback(tick); };
  if (el === 'vid') node.requestVideoFrameCallback(tick); else node.addEventListener('load', read);
  setTimeout(() => { on = false; node.removeEventListener('load', read); lats.sort((a, b) => a - b); done({ fps: +(n / (ms / 1000)).toFixed(1), p50: lats[Math.floor(lats.length / 2)] ?? -1, p95: lats[Math.floor(lats.length * 0.95)] ?? -1, n }); }, ms);
}), el, ms);

const shown = (viewer: Page) => viewer.evaluate(() => {
  const i = document.getElementById('img') as HTMLImageElement, v = document.getElementById('vid') as HTMLVideoElement;
  return !v.hidden && v.videoWidth > 0 ? 'vid' : !i.hidden && i.naturalWidth > 0 ? 'img' : null;
});
const readEv = (page: Page) => page.evaluate(() => (window as any).__ev as string[]);

try {
  // 第一次安裝會自動開說明頁；在上面填的信令設定要通過驗證才存進 storage.local
  const welcome = await until('安裝說明頁開啟', async () => (await browser.pages()).find((p) => p.url().endsWith('/welcome.html')));
  const saveSig = async (url: string, token: string) => {
    await welcome.evaluate((u, t) => {
      (document.getElementById('sigurl') as HTMLInputElement).value = u; (document.getElementById('sigtoken') as HTMLInputElement).value = t;
      document.getElementById('sigmsg')!.textContent = ''; document.getElementById('sigsave')!.click();
    }, url, token);
    await until('說明頁顯示儲存結果', () => welcome.evaluate(() => document.getElementById('sigmsg')!.textContent));
    return sw.evaluate(async () => (await chrome.storage.local.get('signal')).signal as { url: string; token: string } | undefined);
  };
  ok('安裝後自動開啟說明頁', true);
  ok('說明頁：token 太短不儲存', (await saveSig('ws://127.0.0.1:1/ws', 'short')) === undefined);
  ok('說明頁：位址與 token 合法 → 存進 storage.local', (await saveSig('ws://127.0.0.1:1/ws', 'x'.repeat(24)))?.token === 'x'.repeat(24));
  await sw.evaluate(() => chrome.storage.local.remove('signal')); // 不讓後面的測試去連不存在的伺服器
  await welcome.close();

  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(site.url);
  // AI 的分頁群組；允許所有網段（本機沒有 Tailscale 位址也能連）
  await sw.evaluate(async (url) => {
    const [t] = await chrome.tabs.query({ url: url + '*' });
    const gid = await chrome.tabs.group({ tabIds: [t!.id!] });
    await chrome.tabGroups.update(gid, { title: '⌛ Claude' });
    await chrome.storage.local.set({ nets: ['0.0.0.0/0', '::/0'] });
  }, site.url);

  // 從插件頁面送 v-connect（背景程式收不到自己送的訊息）。host 會忽略自己這台的請求，
  // 所以每次連線前把 deviceId 設成 viewer-side，viewer 讀完（狀態變成「連線中」）就換成 host-side，假裝 host 是另一台
  const popup = await browser.newPage();
  popup.on('pageerror', (e) => errors.push(String(e)));
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.evaluate(() => {
    chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.cg_status) chrome.storage.local.set({ deviceId: 'host-side' }); });
  });
  const connect = async () => {
    await popup.evaluate(async () => { await chrome.storage.local.set({ deviceId: 'viewer-side' }); chrome.runtime.sendMessage({ target: 'sw', type: 'v-connect' }); });
  };
  const setTune = (mode: 'video' | 'image') => popup.evaluate((mode) => chrome.storage.local.set({ tune: { quality: 50, fast: 0, format: 'jpeg', mode } }), mode);

  await connect();
  const viewer = await until('檢視分頁開啟', async () => (await browser.pages()).find((p) => p.url().endsWith('/viewer.html')));
  viewer.on('pageerror', (e) => errors.push(String(e)));

  // ---- 視訊模式（預設）----
  await until('視訊畫面', () => shown(viewer).then((s) => s === 'vid'));
  ok('視訊協商成功', (await hostLog()).includes('開始傳畫面，視訊 true'));
  ok('狀態文字', await until('狀態', () => viewer.evaluate(() => document.getElementById('status')!.textContent === '⌛ AI 執行中')));
  ok('分頁列', await viewer.evaluate(() => document.querySelectorAll('#tablist .tab').length) === 1);
  ok('網址列', await viewer.evaluate(() => (document.getElementById('addr') as HTMLInputElement).value) === site.url);
  await sleep(3000); // 暖機
  const v1 = await probe(viewer, 'vid', 5000);
  ok('視訊 fps > 25', v1.fps > 25, `${v1.fps} fps，延遲 p50 ${v1.p50} ms／p95 ${v1.p95} ms（${v1.n} 張）`);

  const clickCenter = async (sel: string) => {
    const box = (await (await viewer.$(sel))!.boundingBox())!;
    await viewer.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await viewer.keyboard.press('k');
  };
  const inputWorks = async (label: string) => {
    const before = (await readEv(page)).length;
    await clickCenter((await shown(viewer)) === 'vid' ? '#vid' : '#img');
    const ev = await until('測試頁收到輸入', async () => { const e = await readEv(page); return e.length >= before + 2 ? e.slice(before) : null; }, 5000).catch(() => readEv(page).then((e) => e.slice(before)));
    ok(label + ' 滑鼠點擊', ev.some((e) => e.startsWith('click:')), ev.join(' '));
    ok(label + ' 鍵盤', ev.includes('keydown:k'));
  };
  await inputWorks('視訊');

  // ---- 切成圖片模式：不重連 ----
  await setTune('image');
  await until('切換成圖片', () => shown(viewer).then((s) => s === 'img'));
  await sleep(1500);
  const i1 = await probe(viewer, 'img', 4000);
  ok('圖片模式有在更新', i1.fps > 5, `${i1.fps} fps，延遲 p50 ${i1.p50} ms／p95 ${i1.p95} ms`);
  ok('圖片模式時視訊隱藏', await viewer.evaluate(() => document.getElementById('vid')!.hidden === true));
  await inputWorks('圖片');

  // ---- 再切回視訊 ----
  await setTune('video');
  await until('切回視訊', () => shown(viewer).then((s) => s === 'vid'));
  await sleep(1500);
  const v2 = await probe(viewer, 'vid', 3000);
  ok('切回視訊後恢復', v2.fps > 25, `${v2.fps} fps`);

  // ---- 靜止頁面：沒有新畫面時，host 會重寫上一張，視訊不能卡住 ----
  await page.goto(site.url + '?static');
  await sleep(2500);
  const vs = await probe(viewer, 'vid', 4000);
  ok('靜止頁面視訊仍在', vs.n >= 2 && (await shown(viewer)) === 'vid', `${vs.n} 張／4 秒`);
  await page.goto(site.url);
  await sleep(1500);

  // ---- 連續重連 5 次：每次都要重新出視訊（驗證協商與資源清理）----
  for (let i = 1; i <= 5; i++) {
    await connect();
    await sleep(1500);
    await until(`第 ${i} 次重連後有視訊`, async () => (await shown(viewer)) === 'vid');
    const r = await probe(viewer, 'vid', 2000);
    // 串流是在 offscreen 的 realm 建的，instanceof MediaStream 跨 realm 會是 false，改看有沒有方法
    const live = await viewer.evaluate(() => (((document.getElementById('vid') as HTMLVideoElement).srcObject as MediaStream | null)?.getVideoTracks?.()[0]?.readyState) === 'live');
    ok(`第 ${i} 次重連`, r.fps > 5 && live, `${r.fps} fps（剛連上編碼器還在暖機，只確認有在出畫面），串流 live=${live}`); // 穩態效能在上面的 fps > 25 量
  }

  // ---- 握手資料大小（storage.sync 單筆上限約 8 KB，按字串化後算）----
  const log = await hostLog();
  const sizes = [...log.matchAll(/字串化長度 (\d+)/g)].map((m) => Number(m[1]));
  ok('offer／answer 都低於 8192 位元組', sizes.length > 0 && Math.max(...sizes) < 8192, `最大 ${Math.max(...sizes)}`);
  const perfLines = log.split('\n').filter((l) => l.includes('[perf] 截圖')), vidLines = log.split('\n').filter((l) => l.includes('[視訊] 編出'));
  ok('host 有截圖量測紀錄', perfLines.length >= 3, `${perfLines.length} 行；例：${perfLines.at(-2)}`);
  ok('host 有視訊編碼量測紀錄', vidLines.length >= 3, `${vidLines.length} 行；例：${vidLines.at(-2)}`);
  console.log([...perfLines, ...vidLines].sort().map((l) => '     ' + l).join('\n'));
  ok('沒有視訊編碼失敗', !log.includes('視訊編碼失敗'));
  ok('沒有視訊不可用', !log.includes('視訊不可用'));

  // ---- 關掉檢視分頁：連線停止，host 放開 debugger ----
  const ended = (l: string) => l.split('結束連線： viewer-left').length - 1; // 前面每次重連都留下一筆，要等「新增」的那一筆
  const endedBefore = ended(await hostLog());
  await viewer.close();
  const final = await until('host 結束連線', async () => { const l = await hostLog(); return ended(l) > endedBefore ? l : null; });
  ok('關閉檢視頁後 host 結束連線', true);
  // 這個插件若還接著，detach 會成功；已放開才會失敗（測試工具自己也接著，getTargets 分不出是誰）
  const stillAttached = await sw.evaluate(async (url) => {
    const [t] = await chrome.tabs.query({ url: url + '*' });
    return chrome.debugger.detach({ tabId: t!.id! }).then(() => true, () => false);
  }, site.url);
  ok('debugger 已放開', !stillAttached);
  ok('沒有未捕捉的錯誤', !errors.length, errors.join(' | '));
  if (fail) console.log(final);
} catch (e) {
  fail++;
  console.log('FAIL', e);
  console.log(await hostLog().catch(() => ''));
} finally {
  await browser.close();
  site.close();
}
console.log(fail ? `${fail} 項失敗` : '全部通過');
process.exit(fail ? 1 : 0);
