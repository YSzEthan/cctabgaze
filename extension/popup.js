const $ = (id) => document.getElementById(id);
const HINT = { host: '待命：有 Claude 分頁時才回應連線請求', viewer: '點 Viewer 開始連線' };

async function render() {
  const { role = 'host' } = await chrome.storage.local.get('role');
  $('host').classList.toggle('on', role === 'host');
  $('viewer').classList.toggle('on', role === 'viewer');
  $('hint').textContent = HINT[role];
  $('status').textContent = '';
  renderShow();
}
$('host').onclick = () => chrome.storage.local.set({ role: 'host' });
const VIEWER_URL = chrome.runtime.getURL('viewer.html');
const viewerTab = async () => (await chrome.tabs.query({ url: VIEWER_URL + '*' }))[0];

// 狀態文字只顯示打開之後新產生的，不顯示上一次留下來的
async function renderShow() {
  const { role = 'host' } = await chrome.storage.local.get('role');
  $('show').hidden = !(role === 'viewer' && await viewerTab());
}
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local') return;
  if (ch.role) render();
  if (ch.cg_status) { $('status').textContent = ch.cg_status.newValue; renderShow(); }
});

// 按 Viewer：設成 viewer 並立刻連線。連線在背景 offscreen 跑，第一張畫面到了才會開檢視分頁
$('viewer').onclick = async () => {
  await chrome.storage.local.set({ role: 'viewer' });
  chrome.runtime.sendMessage({ target: 'sw', type: 'v-connect' });
};
$('show').onclick = async () => {
  const t = await viewerTab();
  await chrome.tabs.update(t.id, { active: true });
  await chrome.windows.update(t.windowId, { focused: true });
  window.close();
};
$('showlog').onclick = async () => {
  const { cg_log = [] } = await chrome.storage.local.get('cg_log');
  $('log').textContent = cg_log.slice(-40).join('\n') || '（沒有紀錄）';
  $('log').hidden = !$('log').hidden;
};
render();
