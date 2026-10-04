# cctabgaze

在本機 Chrome 旁觀遠端 Chrome 裡 AI 正在操作的分頁。第 1 階段只看不動。

```
本機 Chrome ── ssh -L 17817 ──► relay.js（遠端，只綁 127.0.0.1）◄── 插件（debugger 截圖）
```

## 遠端（執行 Chrome 的那台）

1. 啟動轉接程式：`bun server/relay.js`（埠可用 `CCTABGAZE_PORT` 覆寫）
2. `chrome://extensions` → 開啟開發人員模式 → 載入未封裝項目 → 選 `extension/`

## 本機

1. `ssh -N -L 17817:localhost:17817 <user>@<遠端 IP>`
2. Chrome 開 `http://localhost:17817`

## 行為

- 沒有檢視頁連線時，插件不接任何分頁、不截圖。
- 優先顯示「已被別的偵錯者接上」的分頁（AI 的分頁）；AI 閒置時退回最近使用過的一般網頁分頁。
- 畫面沒變時送 `same` 訊號，檢視頁可分辨「沒變」和「卡死」。

## 限制與安全

- 插件擁有 `debugger` 權限，但只呼叫 `getTargets`、`attach`、`detach`、`Page.captureScreenshot`。
- relay 丟棄檢視頁送來的一切訊息；檢查 `Host` 與 `Origin`；只綁 `127.0.0.1`。
- `/ext` 接受任何 `chrome-extension://` 來源，第 2 階段開放輸入前必須釘住插件 ID。
- 分頁在 `chrome://` 頁面時截不到，檢視頁會顯示原因。
