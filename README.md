# cctabgaze

在另一台電腦的 Chrome 旁觀這台 Chrome 裡 AI（Claude in Chrome）正在操作的分頁，並可從那台操作（滑鼠、滾輪、鍵盤、輸入法、貼上）。

```
viewer（本機）                       Google 同步                         host（遠端）
點 Viewer → 寫入 cg_req ───────────────────────────────►  背景程式被叫醒
                                                          有 Claude 分頁群組才回應
收到 cg_res ◄────────────────────────────────────────  寫入 cg_res（answer）
WebRTC 直連（Tailscale）◄══════ 畫面 ═════════════════  debugger 截圖，只送最新一張
```

- host 平常待命，不主動寫入任何資料；**只有 Claude 分頁群組存在時才會回應連線請求**。
- 同步只用來交換連線資訊（只含允許網段內的位址，預設是 Tailscale），畫面走 WebRTC 直連，不經過 Google。
- 不需要 ssh、不需要常駐程式。

## 安裝（兩台都做一次）

1. 兩台 Chrome 登入同一個 Google 帳號並開啟同步。
2. 兩台都在 Tailscale 網路內（或在你另外設定的允許網段內，見「允許的網段」）。
3. `chrome://extensions` → 開啟開發人員模式 → 載入未封裝項目 → 選 `extension/`。兩台的插件 ID 都是 `offomejgoflopledfnhhkdldnhfejgjl`（manifest 固定了 `key`，`storage.sync` 依 ID 分區，ID 不同就不會互通）。
4. 預設角色是 host，遠端那台不用設定。本機點插件圖示，在懸浮視窗按「Viewer」。

## 使用

本機點插件圖示 → Viewer，立刻連線。連線在背景跑，狀態顯示在懸浮視窗；第一張畫面到了才會開出檢視分頁，連線成功前不會有任何分頁。約 10 秒內出現畫面。沒有 AI 在運作時會顯示「AI 目前沒有在運作」。

檢視頁上方是網址列與分頁列：

- `‹` `›` `⟳` 與網址框（Enter 導向，沒有協定會補 `https://`）作用在目前截的分頁。
- 分頁列列出 host 上 Claude 分頁群組的所有分頁。點分頁＝釘選它（只換截圖對象，不會切換 host 作用中的分頁）；`×` 關閉；`＋` 開新分頁並加入群組；「自動」回到跟隨 AI。群組只剩一個分頁時不能關（關光等於 AI 結束）。

**關掉檢視分頁、把它導去別的網址、或在懸浮視窗切回 Host，連線就會停止**（host 的 debugger 也會放開）。host 端的人在 Chrome 的「正在偵錯此瀏覽器」提示列按「取消」，也會結束這次連線。host 被連上時畫面截圖期間會一直出現這個提示列。

**複製與貼上：** 在 viewer 按 Cmd+C（或 Cmd+X），host 目前選取的文字會寫進 viewer 這台的剪貼簿（密碼欄位不讀）。按 Cmd+V 貼的是 viewer 這台的剪貼簿，長文字會分段送。

出問題時按「診斷紀錄」。紀錄存在各自機器的本機：viewer 的檢視頁看到的是 viewer 這台的紀錄（含 `[viewer]` 前綴的連線紀錄），要看 host 的得在 host 那台開懸浮視窗按「紀錄」。

## 畫面設定

懸浮視窗的「畫面設定」可選品質（30／50／75／90）、速率上限（5／10／15 fps／最快）、格式（JPEG／WebP／PNG）。設定存在 viewer 這台，連線後經 DataChannel 送給 host，連線中改了馬上生效；host 只接受這幾個固定選項，其餘用預設（品質 50、最快、JPEG）。PNG 無損但檔案大、較慢；WebP 與 JPEG 的取捨見「效能」。

## 允許的網段

連線只接受允許網段內的位址，預設是 `100.64.0.0/10` 與 `fd7a:115c:a1e0::/48`（Tailscale；NetBird 的 `100.96.x.x` 也落在第一段）。換別的 VPN 或要放寬，在懸浮視窗的「允許的網段」一行一個填 CIDR，留空還原預設。

- **設定存在各機器本機，不同步**，所以兩台都要各設一次。
- 過濾分兩層：SDP 裡不在網段內的 candidate 全部丟掉；連上後再讀實際選用的兩端位址，任一邊不在網段內（或讀不到）就關閉連線。
- 位址必須是乾淨的 IP 字面值，主機名、`.local`、IPv4-mapped IPv6 一律拒絕。
- 解析邏輯有測試：`node test/rtc.test.js`。

## 安全

- 兩台都帶 `debugger` 權限（Chrome 不允許設為選用），但 viewer 角色的程式不會使用它。
- host 只呼叫 `debugger` 的 attach、detach、`Page.captureScreenshot`、固定的三種輸入指令（`Input.dispatchMouseEvent`、`Input.dispatchKeyEvent`、`Input.insertText`），以及複製用的一段寫死的 `Runtime.evaluate`（不接受 viewer 傳來的任何程式碼）。
- viewer 送來的輸入在 `background.js` 的 `input()` 逐項檢查：型別與按鍵查表、數值夾範圍、字串截斷，參數從零組起；沒接上分頁、或輸入帶的分頁編號和目前接上的不同，一律丟棄。
- offer 與 answer 都只保留允許網段內的位址，連上後再檢查實際位址（見「允許的網段」）。
- **沒有操作限制**：同一個 Google 帳號、且在同一個 Tailscale 網路內的裝置，連上就能在 host 已登入的網站上點擊與輸入，沒有另外的配對密碼或「允許操作」開關。輸入內容（包含密碼欄位）走 DataChannel，經 Tailscale 與 DTLS 加密，不經過 Google 同步。

## 分頁控制的風險

- 網址不限制：可導向 `file://` 讀 host 本機檔案並顯示在畫面上（host 需在 `chrome://extensions` 對這個插件開啟「允許存取檔案網址」才會成功）；`chrome://` 頁面可以導向，但截不到，畫面會顯示錯誤，仍可用網址列導回。
- 從這裡新開的分頁會進入 Claude 的分頁群組，AI 看得到、可能去操作或關掉它。
- 你導向或關閉分頁，AI 不會被通知，可能讓它的操作失敗，沒有互斥。

## 限制

- 握手約 6 到 10 秒，受 Chrome 同步速度影響。
- 「AI 是否開著」以分頁群組標題為準（`Claude`、`Claude (MCP)`，前面可有 ⌛🔔✅），這是 Claude 插件的實作細節，它改版可能失效。
- 截不到 `chrome://` 頁面。
- Chrome 自己的介面（原生右鍵選單、`<select>` 下拉、檔案選擇、`alert`／`confirm`、密碼提示）截不到，也點不到，可能擋住後續輸入。
- viewer 的 Chrome 會先吃掉部分快捷鍵（Cmd+W、Cmd+T 等）。
- 你和 AI 可以同時操作同一個分頁，沒有互斥。
- 沒有聲音。畫面是連續截圖，不是影片。

## 效能（實測）

- 截圖間隔：畫面有變化時，上一張**確認送達**後 40 ms 內再截下一張（送達前不截新的，沒有備援計時器）；沒變化時每 500 ms 檢查一次並送 `same`。
- host 螢幕鎖定、負載測試頁（時鐘加持續重繪的色塊，每張約 63 KB）：剛連上約 14 到 15 fps，之後會隨 host 的系統負載降到約 9 到 11 fps（開著 macOS 螢幕共享時最明顯）；延遲額外約 +30 到 +50 ms。右上角會顯示近 5 秒的 fps 與額外延遲。間隔下限從 100 ms 降到 40 ms 前是約 9.7 fps。
- 單張成本約：截圖 20 到 45 ms、送達 45 到 70 ms。**瓶頸在頁面渲染，不在 JPEG 編碼或頻寬**：降品質到 35、開 `optimizeForSpeed` 實測都沒有變快，所以維持品質 50；也因此縮小尺寸不會更快。
- 不用 CDP `Page.startScreencast`：host 螢幕鎖定、頁面不可見時，它一張畫面都不會產生（實測 0 張），而 `Page.captureScreenshot` 不受影響。
- 不用 `clip`＋`scale` 縮小截圖：它會暫時改頁面的模擬尺寸，可能干擾 AI 自己的截圖與點擊。

## 歷史

兩個插件交換 WebRTC 連線資訊的原型在 commit `fc8e4e6`，壓力測試版在 `8ac7fd2`（`proto-b/`，已刪除）。第 1 階段的 relay + `ssh -L` 方案在 commit `fdb1bd4`。
