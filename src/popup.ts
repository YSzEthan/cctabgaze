import { DEFAULT_NETS, parseNets } from './rtc.ts';
import type { Tune } from './protocol.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const HINT: Record<string, string> = { host: '待命：有 Claude 分頁時才回應連線請求', viewer: '點 Viewer 開始連線' };
const getRole = async () => (await chrome.storage.local.get<{ role: string }>('role')).role ?? 'host';

async function render() {
  const role = await getRole();
  $('host').classList.toggle('on', role === 'host');
  $('viewer').classList.toggle('on', role === 'viewer');
  $('hint').textContent = HINT[role] ?? '';
  $('status').textContent = '';
  renderShow();
}
$('host').onclick = () => chrome.storage.local.set({ role: 'host' });
const VIEWER_URL = chrome.runtime.getURL('viewer.html');
const viewerTab = async () => (await chrome.tabs.query({ url: VIEWER_URL + '*' }))[0];

// 狀態文字只顯示打開之後新產生的，不顯示上一次留下來的
async function renderShow() {
  $('show').hidden = !(await getRole() === 'viewer' && await viewerTab());
}
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local') return;
  if (ch.role) render();
  if (ch.cg_status) { $('status').textContent = ch.cg_status.newValue as string; renderShow(); }
});

// 按 Viewer：設成 viewer 並立刻連線。連線在背景 offscreen 跑，第一張畫面到了才會開檢視分頁
$('viewer').onclick = async () => {
  await chrome.storage.local.set({ role: 'viewer' });
  chrome.runtime.sendMessage({ target: 'sw', type: 'v-connect' });
};
$('show').onclick = async () => {
  const t = await viewerTab();
  if (t?.id == null) return;
  await chrome.tabs.update(t.id, { active: true });
  await chrome.windows.update(t.windowId, { focused: true });
  window.close();
};
$('showlog').onclick = async () => {
  const { cg_log = [] } = await chrome.storage.local.get<{ cg_log: string[] }>('cg_log');
  $('log').textContent = cg_log.slice(-40).join('\n') || '（沒有紀錄）';
  $('log').hidden = !$('log').hidden;
};
render();

// ---- 允許的網段：存在這台的 storage.local，不同步（否則拿到帳號的人能自己改寬）----
const netsBox = $<HTMLTextAreaElement>('nets');
chrome.storage.local.get<{ nets: unknown }>('nets').then(({ nets }) => { netsBox.value = (Array.isArray(nets) && nets.length ? nets : DEFAULT_NETS).join('\n'); });
$('netssave').onclick = async () => {
  const lines = netsBox.value.split('\n').map((l) => l.trim());
  const { nets, errors } = parseNets(lines);
  if (errors.length) { $('netsmsg').textContent = '第 ' + errors.map((e) => e.line).join('、') + ' 行格式不正確，未儲存'; return; }
  if (!nets.length) { await chrome.storage.local.remove('nets'); netsBox.value = DEFAULT_NETS.join('\n'); $('netsmsg').textContent = '已還原預設'; return; }
  await chrome.storage.local.set({ nets: lines.filter(Boolean) });
  $('netsmsg').textContent = '已儲存，下次連線生效';
};

// ---- 畫面設定：存在 viewer 這台，背景程式會經 DataChannel 送給 host（host 只認白名單內的值）----
const TUNE_DEFAULT: Tune = { quality: 50, fast: 0, format: 'jpeg', mode: 'video' };
const fm = $<HTMLSelectElement>('fm'), fq = $<HTMLSelectElement>('fq'), fr = $<HTMLSelectElement>('fr'), ff = $<HTMLSelectElement>('ff');
const readTune = (): Tune => ({ quality: Number(fq.value), fast: Number(fr.value), format: ff.value as Tune['format'], mode: fm.value as Tune['mode'] });
chrome.storage.local.get<{ tune: Partial<Tune> }>('tune').then(({ tune }) => {
  const t = { ...TUNE_DEFAULT, ...tune };
  fm.value = t.mode; fq.value = String(t.quality); fr.value = String(t.fast); ff.value = t.format;
});
for (const el of [fm, fq, fr, ff]) el.onchange = () => chrome.storage.local.set({ tune: readTune() });
