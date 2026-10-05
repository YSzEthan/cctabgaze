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
