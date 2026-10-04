# cctabgaze

在另一台電腦的 Chrome 旁觀這台 Chrome 裡 AI（Claude in Chrome）正在操作的分頁，並可從那台操作（滑鼠、滾輪、鍵盤、輸入法、貼上）。

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
4. 預設角色是 host，遠端那台不用設定。本機點插件圖示，在懸浮視窗按「Viewer」。

## 使用

本機點插件圖示 → Viewer，立刻連線。連線在背景跑，狀態顯示在懸浮視窗；第一張畫面到了才會開出檢視分頁，連線成功前不會有任何分頁。約 10 秒內出現畫面。沒有 AI 在運作時會顯示「AI 目前沒有在運作」。

出問題時按「診斷紀錄」，內容同時包含 host 背景程式與這個頁面的紀錄。

## 安全

- 兩台都帶 `debugger` 權限（Chrome 不允許設為選用），但 viewer 角色的程式不會使用它。
- host 只呼叫 `debugger` 的 attach、detach、`Page.captureScreenshot`，以及固定的三種輸入指令：`Input.dispatchMouseEvent`、`Input.dispatchKeyEvent`、`Input.insertText`。
- viewer 送來的輸入在 `background.js` 的 `input()` 逐項檢查：型別與按鍵查表、數值夾範圍、字串截斷，參數從零組起；沒接上分頁、或輸入帶的分頁編號和目前接上的不同，一律丟棄。
- offer 與 answer 都只保留 Tailscale 網段（`100.64.0.0/10`、`fd7a:115c:a1e0::/48`）的位址。
- **沒有操作限制**：同一個 Google 帳號、且在同一個 Tailscale 網路內的裝置，連上就能在 host 已登入的網站上點擊與輸入，沒有另外的配對密碼或「允許操作」開關。輸入內容（包含密碼欄位）走 DataChannel，經 Tailscale 與 DTLS 加密，不經過 Google 同步。

## 限制

- 握手約 6 到 10 秒，受 Chrome 同步速度影響。
- 「AI 是否開著」以分頁群組標題為準（`Claude`、`Claude (MCP)`，前面可有 ⌛🔔✅），這是 Claude 插件的實作細節，它改版可能失效。
- 截不到 `chrome://` 頁面。
- Chrome 自己的介面（原生右鍵選單、`<select>` 下拉、檔案選擇、`alert`／`confirm`、密碼提示）截不到，也點不到，可能擋住後續輸入。
- viewer 的 Chrome 會先吃掉部分快捷鍵（Cmd+W、Cmd+T 等）。Cmd+V 貼的是 viewer 這台的剪貼簿。
- 你和 AI 可以同時操作同一個分頁，沒有互斥。
- 沒有聲音。畫面是連續截圖，不是影片。

## 效能（實測）

- 截圖間隔：畫面有變化時，上一張送完後 100 ms 再截下一張；沒變化時每 500 ms 檢查一次並送 `same`。
- host 螢幕鎖定、負載測試頁（時鐘加持續重繪的色塊）：約 9 fps，額外延遲 +77 ms；改前約 2 fps。右上角會顯示近 5 秒的 fps 與額外延遲。
- 不用 CDP `Page.startScreencast`：host 螢幕鎖定、頁面不可見時，它一張畫面都不會產生（實測 0 張），而 `Page.captureScreenshot` 不受影響。

## 歷史

兩個插件交換 WebRTC 連線資訊的原型在 commit `fc8e4e6`，壓力測試版在 `8ac7fd2`（`proto-b/`，已刪除）。第 1 階段的 relay + `ssh -L` 方案在 commit `fdb1bd4`。
