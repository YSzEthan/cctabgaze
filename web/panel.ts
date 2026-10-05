// 網址列、分頁列、畫面設定：控制 host 的 Claude 分頁群組。host 才是真正的關口（只作用在群組內的分頁、網址補 https://、群組只剩一個不能關），這裡只送請求。
// nav 的 tabId 一律用 host 最近一次送來的 tabs.cur（不是畫面標頭的 tabId：開了截不到畫面的新分頁時，後者會停在舊分頁，導向會被 host 丟棄）。
import { DEFAULT_TUNE, parseTune, TUNE_OPTIONS } from '../src/tune.ts';
import type { CtlEv, TabInfo, Tune } from '../src/protocol.ts';

export interface TabsMsg { cur: number | null; pinned: boolean; tabs: TabInfo[] }
export interface PanelDeps { sendCtl(ev: CtlEv): void; sendTune(t: Tune): void }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const TUNE_KEY = 'cg_tune';
const loadTune = (): Tune => { try { return parseTune(JSON.parse(localStorage.getItem(TUNE_KEY) ?? 'null')); } catch { return DEFAULT_TUNE; } };
const saveTune = (t: Tune) => { try { localStorage.setItem(TUNE_KEY, JSON.stringify(t)); } catch {} };

export function initPanel({ sendCtl, sendTune }: PanelDeps) {
  const addr = $<HTMLInputElement>('addr'), list = $('tablist');
  let tabs: TabsMsg | null = null;
  const curUrl = () => tabs?.tabs.find((t) => t.id === tabs?.cur)?.url ?? '';
  const nav = (a: 'back' | 'forward' | 'reload') => { if (tabs?.cur != null) sendCtl({ type: 'nav', a, tabId: tabs.cur }); };

  // 手指按在分頁列上（可能正要橫向滑動或點選）時不重繪：標題一變整列重建，click 會被吃掉。放開後再套用最新的
  let touching = false, pending: { m: TabsMsg | null } | null = null;
  const release = () => { touching = false; if (pending) { const m = pending.m; pending = null; apply(m); } };
  list.addEventListener('pointerdown', () => { touching = true; });
  for (const ev of ['pointerup', 'pointercancel']) list.addEventListener(ev, () => setTimeout(release, 350)); // click 在 pointerup 之後才到

  function apply(m: TabsMsg | null) {
    tabs = m;
    $('navbar').inert = $('tabs').inert = !m;
    if (!m) { list.replaceChildren(); addr.value = ''; $('auto').hidden = true; return; }
    list.replaceChildren(...m.tabs.map((t) => {
      const el = document.createElement('div'), name = document.createElement('span');
      el.className = 'tab' + (t.id === m.cur ? ' on' : ''); el.dataset.id = String(t.id);
      name.className = 'name'; name.textContent = t.title || t.url || '(無標題)';
      el.append(name);
      if (t.id === m.cur) { const x = document.createElement('span'); x.className = 'x'; x.textContent = '×'; x.dataset.close = '1'; el.append(x); } // 只有目前分頁有 ×，手機上太容易誤觸
      return el;
    }));
    list.querySelector('.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    $('auto').hidden = !m.pinned;
    if (document.activeElement !== addr) addr.value = curUrl(); // 使用者正在輸入時不蓋掉
  }
  const render = (m: TabsMsg | null) => { if (touching) pending = { m }; else apply(m); };

  list.addEventListener('click', (e) => {
    const t = e.target as HTMLElement, el = t.closest<HTMLElement>('.tab');
    if (el) sendCtl({ type: 'tab', a: t.dataset.close ? 'close' : 'select', tabId: Number(el.dataset.id) }); // 目標分頁，不是目前分頁
  });
  $('newtab').onclick = () => sendCtl({ type: 'tab', a: 'open' });
  $('auto').onclick = () => sendCtl({ type: 'tab', a: 'auto' });
  $('back').onclick = () => nav('back');
  $('fwd').onclick = () => nav('forward');
  $('reload').onclick = () => nav('reload');
  // 按鈕不拿走焦點：鍵盤開著時按上一頁不會收起
  for (const b of document.querySelectorAll<HTMLElement>('#navbar button, #tabs button, #bar button')) b.addEventListener('pointerdown', (e) => e.preventDefault());

  // 網址列：form 的 submit 在輸入法組字中確認選字時不會觸發；沒有 Escape，失焦就還原
  $('navbar').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = addr.value.trim();
    if (url && tabs?.cur != null) sendCtl({ type: 'nav', a: 'go', url, tabId: tabs.cur });
    addr.blur(); // 要看頁面，不要叫出隱藏的 kb
  });
  addr.addEventListener('blur', () => { addr.value = curUrl(); });

  // 分頁列在橫向短螢幕預設隱藏，用底部工具列的按鈕切換
  $('tabtoggle').onclick = () => $('tabs').classList.toggle('show');

  // ---- 畫面設定：存在這支手機，連線中改了馬上生效（連線時第一筆資料到了才送，見 app.ts）----
  let tune = loadTune();
  const prefs = $('prefs');
  const LABELS = { mode: '傳輸', quality: '品質（僅圖片）', fast: '速率', format: '格式（僅圖片）' } as const;
  const selects = {} as Record<keyof Tune, HTMLSelectElement>;
  for (const k of ['mode', 'quality', 'fast', 'format'] as const) {
    const label = document.createElement('label'), sel = selects[k] = document.createElement('select');
    label.textContent = LABELS[k]; label.htmlFor = sel.id = 'tune-' + k;
    for (const o of TUNE_OPTIONS[k]) sel.add(new Option(o.label, String(o.value)));
    sel.onchange = () => { tune = parseTune({ ...tune, [k]: TUNE_OPTIONS[k].find((o) => String(o.value) === sel.value)?.value }); saveTune(tune); showTune(); sendTune(tune); };
    prefs.append(label, sel);
  }
  function showTune() {
    for (const k of Object.keys(selects) as (keyof Tune)[]) selects[k].value = String(tune[k]);
    selects.quality.disabled = selects.format.disabled = tune.mode === 'video'; // 視訊模式固定用 JPEG 90 截圖再編碼，這兩項沒作用
  }
  showTune();
  $('settings').onclick = () => { prefs.hidden = !prefs.hidden; $('settings').classList.toggle('on', !prefs.hidden); };

  return { render, tune: () => tune };
}
