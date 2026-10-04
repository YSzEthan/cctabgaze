// 實驗用背景程式：由 run.ts 經偵錯介面呼叫這幾個函式
chrome.action.onClicked.addListener(() => {}); // 有監聽器，點圖示（或模擬點擊）才會授予 activeTab／tabCapture
self.streamId = (tabId) => chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }).then((id) => ({ id }), (e) => ({ error: e.message }));
self.off = async (m) => {
  if (!(await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length)
    await chrome.offscreen.createDocument({ url: 'off.html', reasons: ['USER_MEDIA', 'WEB_RTC'], justification: '擷取分頁畫面並以 WebRTC 傳送' });
  return chrome.runtime.sendMessage({ to: 'off', ...m });
};

// 截圖來源（shot.ts 用）：debugger 連續截圖，一張接一張不等待，每張丟給 offscreen
let shooting = null;
self.shotStart = async ({ tabId, format, quality }) => {
  await chrome.debugger.attach({ tabId }, '1.3');
  const st = shooting = { on: true, error: null, done: null };
  st.done = (async () => {
    while (st.on) {
      const t = performance.now();
      try {
        const { data } = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', { format, ...(format === 'png' ? { optimizeForSpeed: true } : { quality }) });
        chrome.runtime.sendMessage({ to: 'off', cmd: 'frame', b64: data, fmt: format, capMs: performance.now() - t }).catch(() => {});
      } catch (e) { st.error = e.message; await new Promise((r) => setTimeout(r, 100)); }
    }
    await chrome.debugger.detach({ tabId }).catch(() => {});
  })();
};
self.shotStop = async () => { const st = shooting; if (!st) return {}; st.on = false; await st.done; return { error: st.error }; };
