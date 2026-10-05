// 端對端測試（信令伺服器）：npm run e2e:signal。需要 bun。
// 起一個真的信令伺服器，host 插件連上去；用一般網頁（不是插件）當「手機」：offer 裡只有 .local 位址，
// 透過 POST /offer 取得 answer，確認 DataChannel 開啟、收得到 host 傳來的畫面訊息，且 host 的位址檢查走 lax 模式通過。
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { launch, serve, sleep } from './chrome.ts';

const root = join(import.meta.dirname, '..');
const PORT = 18790, TOKEN = 'e2e-token-' + 'x'.repeat(20);
let fail = 0;
const ok = (name: string, pass: boolean, detail: unknown = '') => { if (!pass) fail++; console.log(pass ? 'ok  ' : 'FAIL', name, detail); };
const until = async <T>(what: string, f: () => Promise<T>, ms = 20000): Promise<NonNullable<T>> => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) { const v = await f().catch(() => null); if (v) return v; }
  throw new Error('等不到：' + what);
};

spawnSync('bun', ['build', 'web/app.ts', '--outfile', 'web/app.js', '--target', 'browser'], { cwd: root, stdio: 'ignore' }); // 伺服器要提供最新的網頁
const srv = spawn('bun', [join(root, 'server/index.ts')], { env: { ...process.env, CG_TOKEN: TOKEN, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
let srvOut = '';
srv.stdout.on('data', (d) => { srvOut += d; });
const site = await serve(join(import.meta.dirname, 'fixtures/page.html'));
const { browser, sw } = await launch(join(root, 'extension'));
const hostLog = () => sw.evaluate(async () => ((await chrome.storage.local.get('cg_log')).cg_log as string[]).join('\n'));
const post = (token: string, sdp: string) => fetch(`http://127.0.0.1:${PORT}/offer`, { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify({ sdp }) });

try {
  await until('伺服器啟動', async () => srvOut.includes('port ' + PORT));

  // 沒有 host 時
  const early = await post(TOKEN, 'v=0');
  ok('host 離線時回 host-offline', (await early.json() as { error?: string }).error === 'host-offline');
  ok('token 錯誤回 401', (await post('wrong-token', 'v=0')).status === 401);

  const page = await browser.newPage();
  await page.goto(site.url);
  await sw.evaluate(async (url, port, token) => { // AI 的分頁群組；網段用預設（Tailscale），這台有 100.x 位址才會過
    const [t] = await chrome.tabs.query({ url: url + '*' });
    const gid = await chrome.tabs.group({ tabIds: [t!.id!] });
    await chrome.tabGroups.update(gid, { title: '⌛ Claude' });
    await chrome.storage.local.set({ signal: { url: `ws://127.0.0.1:${port}/ws`, token } });
  }, site.url, PORT, TOKEN);
  await until('host 連上伺服器', async () => srvOut.includes('host 已連上'));
  ok('host 連上信令伺服器', true);

  // 「手機」：一般網頁，預設的 WebRTC 隱私設定，offer 裡只會有 .local 位址
  const offer = await page.evaluate(async () => {
    const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
    const w = window as any;
    w.pc = pc; w.msgs = 0; w.open = false;
    const dc = pc.createDataChannel('v');
    dc.onopen = () => { w.open = true; };
    dc.onmessage = () => { w.msgs++; };
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise<void>((r) => { const t = setTimeout(r, 4000); pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); r(); } }; });
    return pc.localDescription!.sdp;
  });
  const cands = offer.split('\n').filter((l) => l.startsWith('a=candidate')).map((l) => l.split(' ')[4]);
  ok('手機的 offer 沒有 Tailscale 位址', cands.every((a) => !/^100\./.test(a ?? '')), cands.join(' '));

  const res = await (await post(TOKEN, offer)).json() as { sdp?: string; error?: string };
  ok('取得 answer', !!res.sdp, res.error ?? '');
  await page.evaluate((sdp) => (window as any).pc.setRemoteDescription({ type: 'answer', sdp }), res.sdp!);

  await until('DataChannel 開啟', () => page.evaluate(() => (window as any).open as boolean), 15000);
  ok('DataChannel 開啟', true);
  await until('收到 host 傳來的畫面訊息', () => page.evaluate(() => (window as any).msgs > 0 ? true : null), 10000);
  ok('收到畫面訊息', true);
  const log = await hostLog();
  ok('host 用信令伺服器的請求', log.includes('（信令伺服器）'));
  ok('位址檢查通過', /選用 pair: 100\.\S+ → /.test(log) && !log.includes('不在允許網段內'), log.split('\n').filter((l) => l.includes('選用 pair')).join(' | '));

  // 同一個伺服器再連一次：新的請求取代舊的
  const offer2 = await page.evaluate(async () => {
    const pc = new RTCPeerConnection({ iceServers: [] });
    (window as any).pc2 = pc;
    pc.createDataChannel('v');
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise<void>((r) => { const t = setTimeout(r, 4000); pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); r(); } }; });
    return pc.localDescription!.sdp;
  });
  const res2 = await (await post(TOKEN, offer2)).json() as { sdp?: string; error?: string };
  ok('第二次請求也拿得到 answer', !!res2.sdp, res2.error ?? '');

  // ---- 真的 PWA：靜態檔、固定名單、token 從網址片段帶入 ----
  const base = `http://127.0.0.1:${PORT}`;
  ok('GET / 回網頁', (await fetch(base + '/')).headers.get('content-type')?.startsWith('text/html') === true);
  ok('GET /app.js', (await fetch(base + '/app.js')).status === 200);
  ok('GET /manifest.webmanifest', (await fetch(base + '/manifest.webmanifest')).status === 200);
  ok('不在名單內的路徑回 404', (await fetch(base + '/server/index.ts')).status === 404 && (await fetch(base + '/%2e%2e/package.json')).status === 404);
  const pwa = await browser.newPage();
  const pwaErrors: string[] = [];
  pwa.on('pageerror', (e) => pwaErrors.push(String(e)));
  await pwa.goto(`${base}/#t=${TOKEN}`);
  const shownView = () => pwa.evaluate(() => {
    const v = document.getElementById('vid') as HTMLVideoElement, i = document.getElementById('img') as HTMLImageElement;
    return !v.hidden && v.videoWidth > 0 ? 'vid' : !i.hidden && i.naturalWidth > 0 ? 'img' : null;
  });
  const view = await until('PWA 顯示畫面', shownView, 20000);
  ok('PWA 顯示 host 的畫面', true, view);
  ok('PWA 走視訊模式', view === 'vid');
  ok('token 已從網址移除並存起來', await pwa.evaluate(() => location.hash === '' && localStorage.getItem('cg_token') !== null));
  ok('PWA 沒有未捕捉的錯誤', !pwaErrors.length, pwaErrors.join(' | '));

  // ---- 觸控：手機尺寸，點擊、拖曳捲動、雙指縮放、鍵盤 ----
  await pwa.setViewport({ width: 400, height: 800, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  await until('改成手機尺寸後（頁面會重新載入）重新連上並顯示畫面', shownView, 20000);
  await sleep(1000);
  const hostEv = () => page.evaluate(() => (window as any).__ev as string[]);
  const taVal = () => page.$eval('#ta', (t) => (t as HTMLTextAreaElement).value); // host 輸入框的內容
  const toastText = () => pwa.$eval('#toast', (t) => t.textContent);
  const vidBox = async () => (await pwa.$eval('#vid', (v) => { const r = v.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }));
  const zoomScale = () => pwa.$eval('#zoom', (z) => new DOMMatrix(getComputedStyle(z).transform).a);
  const b = await vidBox();
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;

  let before = (await hostEv()).length;
  await pwa.touchscreen.tap(cx, cy);
  await sleep(600);
  let ev = (await hostEv()).slice(before);
  ok('輕點 → host 收到 click', ev.some((e) => e.startsWith('click:')), ev.join(' '));
  ok('輕點 → mousedown／mouseup（clickCount 1）', ev.includes('mousedown:1') && ev.includes('mouseup:1'));

  before = (await hostEv()).length;
  const t0 = await pwa.touchscreen.touchStart(cx, cy);
  for (let i = 1; i <= 10; i++) { await t0.move(cx, cy + i * 10); await sleep(40); } // 手指往下拖 100px
  await t0.end();
  await sleep(500);
  ev = (await hostEv()).slice(before);
  const wheels = ev.filter((e) => e.startsWith('wheel:')).map((e) => Number(e.slice(6)));
  const hostW = await page.evaluate(() => innerWidth);
  const sum = wheels.reduce((a, c) => a + c, 0), want = -100 * hostW / b.w;
  ok('單指往下拖 → host 收到向上捲動', sum < 0 && !ev.some((e) => e.startsWith('click:')), ev.join(' '));
  ok('捲動距離與手指一致（用 host 的 CSS 寬度換算）', Math.abs(sum - want) < Math.abs(want) * 0.2, `總和 ${sum}，預期約 ${Math.round(want)}`);

  before = (await hostEv()).length;
  const p1 = await pwa.touchscreen.touchStart(cx - 40, cy), p2 = await pwa.touchscreen.touchStart(cx + 40, cy);
  for (let i = 1; i <= 8; i++) { await p1.move(cx - 40 - i * 10, cy); await p2.move(cx + 40 + i * 10, cy); await sleep(30); }
  const zoomed = await zoomScale();
  await p1.end(); await p2.end();
  await sleep(400);
  ev = (await hostEv()).slice(before);
  ok('雙指張開 → 本機放大', zoomed > 1.5, `倍率 ${zoomed.toFixed(2)}`);
  ok('雙指縮放時 host 沒有收到任何輸入', ev.length === 0, ev.join(' '));

  // 縮放後點擊位置仍對：放大後畫面中心的內容仍在原本的位置附近
  await pwa.touchscreen.tap(cx, cy);
  await sleep(600);
  ev = (await hostEv()).slice(before);
  const click = ev.find((e) => e.startsWith('click:'))?.slice(6).split(',').map(Number);
  ok('縮放後點擊仍送到 host', !!click, ev.join(' '));
  const q1 = await pwa.touchscreen.touchStart(cx - 120, cy), q2 = await pwa.touchscreen.touchStart(cx + 120, cy);
  for (let i = 1; i <= 8; i++) { await q1.move(cx - 120 + i * 14, cy); await q2.move(cx + 120 - i * 14, cy); await sleep(30); }
  await q1.end(); await q2.end();
  await sleep(300);
  ok('雙指縮回 → 貼齊 1 倍', (await zoomScale()) === 1, await zoomScale());

  // 鍵盤：點 host 的輸入框（頁面中心）取得焦點，開手機鍵盤，打字與 Backspace
  await pwa.touchscreen.tap(cx, cy);
  await sleep(500);
  await pwa.tap('#kbd');
  ok('鍵盤按鈕讓 textarea 取得焦點', await pwa.evaluate(() => document.activeElement?.id === 'kb'));
  await pwa.keyboard.type('ab');
  await sleep(500);
  ok('打字 → host 輸入框收到', await taVal() === 'ab', await taVal());
  await pwa.keyboard.press('Backspace');
  await sleep(500);
  ok('Backspace → host 刪一個字', await taVal() === 'a', await taVal());
  await pwa.keyboard.press('Enter');
  await pwa.keyboard.type('x');
  await sleep(500);
  ok('Enter 換行再輸入', await taVal() === 'a\nx', JSON.stringify(await taVal()));
  ok('PWA 觸控與鍵盤沒有未捕捉的錯誤', !pwaErrors.length, pwaErrors.join(' | '));

  // 複製：host 選取輸入框的文字，點「複製」，手機的剪貼簿拿到同樣的內容
  await browser.defaultBrowserContext().overridePermissions(base, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
  await page.$eval('#ta', (t) => { (t as HTMLTextAreaElement).focus(); (t as HTMLTextAreaElement).select(); });
  await pwa.bringToFront();
  await pwa.tap('#copy');
  await sleep(1000);
  ok('複製：手機剪貼簿拿到 host 選取的文字', await pwa.evaluate(() => navigator.clipboard.readText()) === 'a\nx', JSON.stringify(await pwa.evaluate(() => navigator.clipboard.readText()).catch((e) => String(e))));
  ok('複製：顯示已複製', (await toastText()) === '已複製 3 字', await toastText());
  await page.$eval('#ta', (t) => { (t as HTMLTextAreaElement).setSelectionRange(0, 0); });
  await pwa.tap('#copy');
  await sleep(3500);
  ok('複製：host 沒有選取文字時提示', (await toastText()) === 'host 沒有選取的文字', await toastText());

  // 貼上：手機剪貼簿的文字送進 host 取得焦點的輸入框
  await pwa.evaluate(() => navigator.clipboard.writeText('貼上測試\n第二行'));
  await page.$eval('#ta', (t) => { const a = t as HTMLTextAreaElement; a.value = ''; a.focus(); });
  await pwa.tap('#paste');
  await sleep(800);
  const pasted = await taVal();
  ok('貼上：host 輸入框收到手機剪貼簿的文字（含換行）', pasted === '貼上測試\n第二行', JSON.stringify(pasted));
  ok('貼上：顯示已貼上', (await toastText()) === '已貼上 8 字', await toastText());

  await pwa.evaluate(() => localStorage.setItem('cg_token', 'wrong-token-wrong-token-wrong'));
  await pwa.reload();
  ok('token 錯誤時顯示輸入欄', !!(await until('輸入欄', () => pwa.evaluate(() => (document.getElementById('setup') as HTMLElement).hidden === false ? true : null), 10000)));
} catch (e) {
  fail++;
  console.log('FAIL', e);
  console.log(await hostLog().catch(() => ''));
} finally {
  await browser.close();
  site.close();
  srv.kill();
}
console.log(fail ? `${fail} 項失敗` : '全部通過');
process.exit(fail ? 1 : 0);
