// 端對端測試（信令伺服器）：npm run e2e:signal。需要 bun。
// 環境變數 CG_E2E_ANY_NET=1：允許所有網段（機器沒有 Tailscale 位址，例如 CI）；沒設的話用預設網段，會驗證 host 選中的是 Tailscale 位址。
// 起一個真的信令伺服器，host 插件連上去；用一般網頁（不是插件）當「手機」：offer 裡只有 .local 位址，
// 透過 POST /offer 取得 answer，確認 DataChannel 開啟、收得到 host 傳來的畫面訊息，且 host 的位址檢查走 lax 模式通過。
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { launch, serve, sleep } from './chrome.ts';

const root = join(import.meta.dirname, '..');
const ANY_NET = !!process.env.CG_E2E_ANY_NET;
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
  await sw.evaluate(async (url, port, token, anyNet) => { // AI 的分頁群組；網段預設是 Tailscale（這台要有 100.x 位址才會過），沒有就用 CG_E2E_ANY_NET
    const [t] = await chrome.tabs.query({ url: url + '*' });
    const gid = await chrome.tabs.group({ tabIds: [t!.id!] });
    await chrome.tabGroups.update(gid, { title: '⌛ Claude' });
    await chrome.storage.local.set({ signal: { url: `ws://127.0.0.1:${port}/ws`, token }, ...(anyNet && { nets: ['0.0.0.0/0', '::/0'] }) });
  }, site.url, PORT, TOKEN, ANY_NET);
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
  ok('位址檢查通過', (ANY_NET ? /選用 pair: \S+ → / : /選用 pair: 100\.\S+ → /).test(log) && !log.includes('不在允許網段內'), log.split('\n').filter((l) => l.includes('選用 pair')).join(' | '));

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

  // ---- 網址列、上一頁／下一頁／重新整理、分頁列 ----
  const tabsInfo = () => pwa.$$eval('#tablist .tab', (els) => els.map((e) => ({ id: e.getAttribute('data-id')!, on: e.classList.contains('on'), x: !!e.querySelector('.x'), name: e.querySelector('.name')!.textContent })));
  const typeUrl = async (url: string) => { await pwa.$eval('#addr', (a) => { (a as HTMLInputElement).focus(); (a as HTMLInputElement).select(); }); await pwa.keyboard.type(url); await pwa.keyboard.press('Enter'); };
  const hostMarker = () => page.evaluate(() => (window as any).__marker);
  await until('網址列顯示 host 目前網址', async () => (await pwa.$eval('#addr', (a) => (a as HTMLInputElement).value)) === page.url());
  ok('網址列顯示 host 目前網址', true, page.url());
  let tl = await tabsInfo();
  ok('分頁列有一個目前分頁，且有 ×', tl.length === 1 && tl[0]!.on && tl[0]!.x, JSON.stringify(tl));

  await typeUrl(site.url + '?static');
  await until('Enter 導向 host 的分頁', async () => page.url().endsWith('?static'));
  ok('網址列 Enter → host 分頁導向', true, page.url());
  ok('送出後網址框失焦（不叫出隱藏的鍵盤）', await pwa.evaluate(() => document.activeElement?.id !== 'addr' && document.activeElement?.id !== 'kb'));

  await page.evaluate(() => { (window as any).__marker = 1; });
  await pwa.tap('#reload');
  await until('⟳ → host 分頁重新載入', async () => (await hostMarker()) === undefined);
  ok('⟳ → host 分頁重新載入', true);
  await pwa.tap('#back');
  await until('‹ → host 回到上一頁', async () => page.url() === site.url);
  ok('‹ → host 回到上一頁', true, page.url());
  await pwa.tap('#fwd');
  await until('› → host 前往下一頁', async () => page.url().endsWith('?static'));
  ok('› → host 前往下一頁', true, page.url());

  // ＋ 開新分頁：它是 about:blank，截不到畫面；在網址列輸入網址要導向它（nav 的 tabId 必須是 tabs.cur，不是畫面標頭的 tabId）
  await pwa.tap('#newtab');
  tl = await until('分頁列出現第二個分頁', async () => { const t = await tabsInfo(); return t.length === 2 ? t : null; });
  const [origId, newId] = [tl.find((t) => !t.on)!.id, tl.find((t) => t.on)!.id];
  ok('＋ 新分頁成為目前分頁，並出現「自動」', await pwa.$eval('#auto', (b) => !(b as HTMLElement).hidden));
  await typeUrl(site.url + '?static');
  await until('新分頁導向網址（tabId 來自 tabs.cur）', async () => (await tabsInfo()).find((t) => t.id === newId)?.name === '負載測試頁');
  ok('在新分頁的網址列輸入網址 → 新分頁導向', true);

  // 分頁列上橫向拖動不能切換分頁；點選才切換
  const origBox = await pwa.$eval(`.tab[data-id="${origId}"]`, (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  const th = await pwa.touchscreen.touchStart(origBox.x, origBox.y);
  for (let i = 1; i <= 6; i++) { await th.move(origBox.x + i * 10, origBox.y); await sleep(30); }
  await th.end();
  await sleep(700);
  ok('分頁列橫向拖動不會切換分頁', (await tabsInfo()).find((t) => t.on)?.id === newId, JSON.stringify(await tabsInfo()));
  await pwa.tap(`.tab[data-id="${origId}"]`);
  await until('點選分頁 → 切換', async () => (await tabsInfo()).find((t) => t.on)?.id === origId);
  ok('點選分頁 → 切換', true);
  await pwa.tap('#auto');
  await until('「自動」→ 回到跟隨 AI（按鈕消失）', async () => pwa.$eval('#auto', (b) => (b as HTMLElement).hidden));
  ok('「自動」→ 回到跟隨 AI', true);
  await pwa.tap(`.tab[data-id="${newId}"]`);
  await until('切到新分頁', async () => (await tabsInfo()).find((t) => t.on)?.id === newId);
  await pwa.tap(`.tab[data-id="${newId}"] .x`);
  await until('× → 關閉新分頁', async () => (await tabsInfo()).length === 1);
  ok('× → 關閉分頁', true);
  await pwa.tap('.tab.on .x'); // 群組只剩一個分頁：host 不會關（關光等於 AI 結束）
  await sleep(1200);
  ok('只剩一個分頁時 × 不會關', (await tabsInfo()).length === 1 && !page.isClosed());

  // 網址框有焦點時點畫面：網址框失焦
  await pwa.$eval('#addr', (a) => (a as HTMLInputElement).focus());
  const sb = await pwa.$eval('#stage', (s) => { const r = s.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }); // 舞台中心：不依賴視訊元素此刻有沒有佈局好
  await pwa.touchscreen.tap(sb.x, sb.y);
  await sleep(400);
  ok('網址框有焦點時點畫面 → 網址框失焦', await pwa.evaluate(() => document.activeElement?.id !== 'addr'));

  // 畫面設定：改成圖片 → PWA 顯示圖片；重新載入（重連）後仍是圖片（重連重送 tune）；選回視訊
  // 先回到會持續重繪的頁面：?static 只畫一次，host 一直沒有新畫面可送，這段測試的是設定，不是靜止頁面
  await typeUrl(site.url);
  await until('host 回到動態頁面', async () => page.url() === site.url);
  await pwa.tap('#settings');
  ok('設定面板打開，傳輸選視訊時品質與格式停用', await pwa.evaluate(() => !(document.getElementById('prefs') as HTMLElement).hidden && (document.getElementById('tune-quality') as HTMLSelectElement).disabled));
  await pwa.select('#tune-mode', 'image');
  await until('改成圖片模式', async () => (await shownView()) === 'img', 15000);
  ok('設定「圖片」→ 畫面改走圖片', true);
  ok('圖片模式時品質與格式啟用', await pwa.evaluate(() => !(document.getElementById('tune-quality') as HTMLSelectElement).disabled));
  await pwa.reload();
  await until('重新載入後仍是圖片模式（重連重送 tune）', async () => (await shownView()) === 'img', 25000);
  ok('重新連線後仍是圖片模式', true);
  await pwa.tap('#settings');
  await pwa.select('#tune-mode', 'video');
  await until('選回視訊', async () => (await shownView()) === 'vid', 15000);
  ok('設定選回「視訊」', true);
  ok('網頁導覽與設定沒有未捕捉的錯誤', !pwaErrors.length, pwaErrors.join(' | '));

  await pwa.evaluate(() => localStorage.setItem('cg_token', 'wrong-token-wrong-token-wrong'));
  await pwa.reload();
  ok('token 錯誤時顯示輸入欄', !!(await until('輸入欄', () => pwa.evaluate(() => (document.getElementById('setup') as HTMLElement).hidden === false ? true : null), 10000)));

  // 手動輸入 token：輸入框要能用觸控點進去、取得焦點、打字（舞台的 touchstart 擋掉預設行為時，這裡會點不進去）
  const tb = await pwa.$eval('#token', (t) => { const r = t.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  // 真實手機（iOS Safari、Android Chrome）上 touchstart 被取消就點不進輸入框，桌面 Chrome 的觸控模擬不會重現，所以直接驗成因：輸入框上的 touchstart 沒被取消、輸入框可選取文字
  ok('token 輸入框上的 touchstart 沒有被取消（手機才點得進去）', await pwa.$eval('#token', (t) => { const ev = new TouchEvent('touchstart', { bubbles: true, cancelable: true }); t.dispatchEvent(ev); return !ev.defaultPrevented; }));
  ok('token 輸入框可選取文字（iOS 祖先有 user-select:none 就不能輸入）', await pwa.$eval('#token', (t) => { const s = getComputedStyle(t) as CSSStyleDeclaration & { webkitUserSelect: string }; return s.userSelect === 'text' && s.webkitUserSelect === 'text'; }));
  await pwa.touchscreen.tap(tb.x, tb.y);
  ok('觸控點 token 輸入框 → 取得焦點', await pwa.evaluate(() => document.activeElement?.id === 'token'));
  await pwa.keyboard.type(TOKEN);
  ok('token 輸入框可以打字', await pwa.$eval('#token', (t) => (t as HTMLInputElement).value) === TOKEN);
  await pwa.keyboard.press('Enter');
  await until('輸入 token 後連上並顯示畫面', shownView, 20000);
  ok('手動輸入 token → 連線成功', true);
} catch (e) {
  fail++;
  console.log('FAIL', e);
  for (const p of await browser.pages()) if (p.url().startsWith(`http://127.0.0.1:${PORT}`)) console.log('手機網頁狀態：', await p.evaluate(() => ({ status: document.getElementById('status')?.textContent, msg: document.getElementById('msg')?.textContent, go: document.getElementById('go')?.textContent, goHidden: document.getElementById('go')?.hidden, tune: localStorage.getItem('cg_tune') })).catch(() => null));
  console.log(await hostLog().catch(() => ''));
} finally {
  await browser.close();
  site.close();
  srv.kill();
}
console.log(fail ? `${fail} 項失敗` : '全部通過');
process.exit(fail ? 1 : 0);
