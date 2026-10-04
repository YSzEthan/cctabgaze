const $ = (id) => document.getElementById(id);
const HINT = { host: '待命：有 Claude 分頁時才回應連線請求', viewer: '點 Viewer 開啟檢視頁面' };

async function render() {
  const { role = 'host' } = await chrome.storage.local.get('role');
  $('host').classList.toggle('on', role === 'host');
  $('viewer').classList.toggle('on', role === 'viewer');
  $('hint').textContent = HINT[role];
}
$('host').onclick = async () => { await chrome.storage.local.set({ role: 'host' }); render(); };
$('viewer').onclick = async () => {
  await chrome.storage.local.set({ role: 'viewer' });
  await chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') });
  window.close();
};
$('showlog').onclick = async () => {
  const { cg_log = [] } = await chrome.storage.local.get('cg_log');
  $('log').textContent = cg_log.slice(-40).join('\n') || '（沒有紀錄）';
  $('log').hidden = !$('log').hidden;
};
render();
