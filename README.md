# cctabgaze

在另一台電腦的 Chrome 旁觀這台 Chrome 裡 AI（Claude in Chrome）正在操作的分頁。只看不動。

```
viewer（本機）                       Google 同步                         host（遠端）
按「連線」→ 寫入 cg_req ───────────────────────────────►  背景程式被叫醒
                                                          有 Claude 分頁群組才回應
收到 cg_res ◄────────────────────────────────────────  寫入 cg_res（answer）
WebRTC 直連（Tailscale）◄══════ 畫面 ═════════════════  debugger 截圖，只送最新一張
```

- host 平常待命，不主動寫入任何資料；**只有 Claude 分頁群組存在時才會回應連線請求**。
- 同步只用來交換連線資訊（只含 Tailscale 位址），畫面走 WebRTC 直連，不經過 Google。
- 不需要 ssh、不需要常駐程式。

## 安裝（兩台都做一次）

1. 兩台 Chrome 登入同一個 Google 帳號並開啟同步。
2. 兩台都在 Tailscale 網路內。
3. `chrome://extensions` → 開啟開發人員模式 → 載入未封裝項目 → 選 `extension/`。兩台的插件 ID 都是 `offomejgoflopledfnhhkdldnhfejgjl`（manifest 固定了 `key`，`storage.sync` 依 ID 分區，ID 不同就不會互通）。
4. 預設角色是 host，遠端那台不用設定。本機點插件圖示，在懸浮視窗按「Viewer」（會開啟檢視頁面）。

## 使用

本機點插件圖示 → Viewer → 在檢視頁面按「連線」。約 10 秒內出現畫面。沒有 AI 在運作時會顯示「AI 目前沒有在運作」。

出問題時按「診斷紀錄」，內容同時包含 host 背景程式與這個頁面的紀錄。

## 安全

- 兩台都帶 `debugger` 權限（Chrome 不允許設為選用），但 viewer 角色的程式不會使用它。
- host 只呼叫 `debugger` 的 attach、detach、`Page.captureScreenshot`，並丟棄 viewer 送來的所有 DataChannel 訊息。
- offer 與 answer 都只保留 Tailscale 網段（`100.64.0.0/10`、`fd7a:115c:a1e0::/48`）的位址。
- 同一個 Google 帳號、且在同一個 Tailscale 網路內的裝置都能請求觀看，沒有另外的配對密碼。

## 限制

- 握手約 6 到 10 秒，受 Chrome 同步速度影響。
- 「AI 是否開著」以分頁群組標題為準（`Claude`、`Claude (MCP)`，前面可有 ⌛🔔✅），這是 Claude 插件的實作細節，它改版可能失效。
- 截不到 `chrome://` 頁面。
- 沒有滑鼠鍵盤輸入、聲音。畫面是連續截圖，不是影片。

## 效能（實測）

- 截圖間隔：畫面有變化時，上一張送完後 100 ms 再截下一張；沒變化時每 500 ms 檢查一次並送 `same`。
- host 螢幕鎖定、負載測試頁（時鐘加持續重繪的色塊）：約 9 fps，額外延遲 +77 ms；改前約 2 fps。右上角會顯示近 5 秒的 fps 與額外延遲。
- 不用 CDP `Page.startScreencast`：host 螢幕鎖定、頁面不可見時，它一張畫面都不會產生（實測 0 張），而 `Page.captureScreenshot` 不受影響。

## 歷史

兩個插件交換 WebRTC 連線資訊的原型在 commit `fc8e4e6`，壓力測試版在 `8ac7fd2`（`proto-b/`，已刪除）。第 1 階段的 relay + `ssh -L` 方案在 commit `fdb1bd4`。
