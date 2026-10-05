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
3. 編譯：`npm install && npm run build`（原始碼是 `src/` 的 TypeScript，編譯結果輸出到 `extension/`，需要 Node.js）。之後每次更新原始碼都要重新 build，並在 `chrome://extensions` 按重新載入。
4. `chrome://extensions` → 開啟開發人員模式 → 載入未封裝項目 → 選 `extension/`。兩台的插件 ID 都是 `offomejgoflopledfnhhkdldnhfejgjl`（manifest 固定了 `key`，`storage.sync` 依 ID 分區，ID 不同就不會互通）。
5. 預設角色是 host，遠端那台不用設定。本機點插件圖示，在懸浮視窗按「Viewer」。

## 使用

本機點插件圖示 → Viewer，立刻連線。連線在背景跑，狀態顯示在懸浮視窗；第一張畫面到了才會開出檢視分頁，連線成功前不會有任何分頁。約 10 秒內出現畫面。沒有 AI 在運作時會顯示「AI 目前沒有在運作」。

檢視頁上方是網址列與分頁列：

- `‹` `›` `⟳` 與網址框（Enter 導向，沒有協定會補 `https://`）作用在目前截的分頁。
- 分頁列列出 host 上 Claude 分頁群組的所有分頁。點分頁＝釘選它（只換截圖對象，不會切換 host 作用中的分頁）；`×` 關閉；`＋` 開新分頁並加入群組；「自動」回到跟隨 AI。群組只剩一個分頁時不能關（關光等於 AI 結束）。

**關掉檢視分頁、把它導去別的網址、或在懸浮視窗切回 Host，連線就會停止**（host 的 debugger 也會放開）。host 端的人在 Chrome 的「正在偵錯此瀏覽器」提示列按「取消」，也會結束這次連線。host 被連上時畫面截圖期間會一直出現這個提示列。

**複製與貼上：** 在 viewer 按 Cmd+C（或 Cmd+X），host 目前選取的文字會寫進 viewer 這台的剪貼簿（密碼欄位不讀）。按 Cmd+V 貼的是 viewer 這台的剪貼簿，長文字會分段送。

出問題時按「診斷紀錄」。紀錄存在各自機器的本機：viewer 的檢視頁看到的是 viewer 這台的紀錄（含 `[viewer]` 前綴的連線紀錄），要看 host 的得在 host 那台開懸浮視窗按「紀錄」。

## 畫面設定

懸浮視窗的「畫面設定」，設定存在 viewer 這台，連線後經 DataChannel 送給 host，連線中改了馬上生效（不用重連）；host 只接受固定選項，其餘用預設。

- **傳輸**：
  - **視訊（預設）**：host 照樣用 debugger 截圖（固定 JPEG 品質 90），但不逐張送圖片，而是解碼後餵進 H264 視訊編碼器，經 WebRTC 視訊軌傳送。頻寬約為逐張 JPEG 的 1/4 到 1/8。
  - **圖片（備案）**：逐張 JPEG／WebP／PNG 走 DataChannel，下面的品質與格式只在這個模式有效。
  - 協商不到視訊（對方是舊版、瀏覽器沒有 H264、視訊與資料不在同一條連線）或 host 本機編碼壞掉時，自動退回圖片。
- **品質**（30／50／75／90）、**格式**（JPEG／WebP／PNG）：僅圖片模式。
- **速率**：上限 5／10／15／25 fps 或不限（預設不限）。上限是指兩張畫面之間的最短間隔。

## 信令伺服器（手機 PWA 用，開發中）

手機沒有 Chrome 插件，無法用 Google 同步交換連線資訊，所以另有一個自架的信令伺服器（Bun）。它只轉送 offer 與 answer，畫面與輸入仍走 WebRTC 直連（經 Tailscale），不經伺服器。伺服器同時提供手機用的網頁（PWA，`web/`）。目前手機網頁只能**看畫面**；點擊、捲動、鍵盤、分頁列與設定還沒做。

```
手機 ── POST /offer ──► 伺服器 ◄══ WebSocket ══ host 插件
手機 ◄── answer ───────  伺服器 ◄── answer ───── host 插件
手機 ◄══════════ WebRTC 直連（Tailscale）══════════► host
```

**架設（伺服器那台，macOS）：**

1. 安裝 [Bun](https://bun.sh)，執行 `scripts/install-server.sh`。它會產生 token（`~/.config/cctabgaze/token`，權限 600）、把伺服器複製到 `~/.config/cctabgaze/server`，並裝成 launchd 服務（預設 port 8790，開機自動啟動、掛了自動重啟）。改了 `server/` 要重跑一次。
2. 用 Tailscale 提供 HTTPS：`tailscale serve --bg --https=8443 8790`（只有你的 tailnet 連得到；**不要用 `tailscale funnel`**，那會開到公網）。
3. host 的插件懸浮視窗 →「信令伺服器」，填 `wss://<主機名>.<tailnet>.ts.net:8443/ws` 與 token。留空就不連線，原本的 Google 同步路徑照常運作。
4. 手機（要先開 Tailscale）開 `https://<主機名>.<tailnet>.ts.net:8443/#t=<token>`：token 只在第一次要帶，之後存在手機的 localStorage（網址片段不會送到伺服器，讀完就從網址移除）。之後點「連線」。可以加到主畫面。token 錯誤會回到輸入欄。
5. 手動測試：`CG_TOKEN=<至少 24 字元> bun server/index.ts`；`npm run e2e:signal` 會起伺服器並用一般網頁模擬手機連一次。

**手機連線的特性：** 手機瀏覽器（實測 iPhone Safari）的 offer 裡沒有 Tailscale 位址，只有 `.local` 或區網位址，所以 host 對信令伺服器來的請求不要求 offer 帶允許網段的位址，連上後只檢查 host 這邊選中的本機位址在允許網段內（連線一定是從 Tailscale 通道進來的），對方位址讀得到時仍必須在網段內。host 回的 answer 仍只含允許網段內的位址。手機端（Safari 把兩端位址都遮蔽）無法檢查對方位址。

**信任模型（和同步路徑不同）：** 同步路徑靠「同一個 Google 帳號加同一個 Tailscale 網路」；信令伺服器靠「token 加 Tailscale 網路」。

- 伺服器等同完全信任：被入侵的伺服器能替換兩端 SDP 裡的 DTLS 指紋做中間人，看到畫面與所有輸入（含密碼）。只能跑在自己的機器上。
- token 是唯一的認證（至少 24 字元，伺服器以常數時間比對）。知道 token 且在你的 tailnet 內的人，可以操作 host 登入中的網站（host 沒有操作限制）。外洩就刪掉 `~/.config/cctabgaze/token`、重跑安裝腳本，並更新 host 插件的設定。
- 兩條路徑同時開著，攻擊面是兩者的聯集；不需要同步路徑的話，可以用 Tailscale ACL 限制誰能連伺服器。

## 允許的網段

連線只接受允許網段內的位址，預設是 `100.64.0.0/10` 與 `fd7a:115c:a1e0::/48`（Tailscale；NetBird 的 `100.96.x.x` 也落在第一段）。換別的 VPN 或要放寬，在懸浮視窗的「允許的網段」一行一個填 CIDR，留空還原預設。

- **設定存在各機器本機，不同步**，所以兩台都要各設一次。
- 過濾分兩層：SDP 裡不在網段內的 candidate 全部丟掉；連上後再讀實際選用的兩端位址，任一邊不在網段內（或讀不到）就關閉連線。
- 位址必須是乾淨的 IP 字面值，主機名、`.local`、IPv4-mapped IPv6 一律拒絕。
- 解析邏輯有測試：`npm test`。

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
- 沒有聲音。視訊模式的來源仍是連續截圖（編碼成視訊串流傳送），不是真正的螢幕錄影，fps 受截圖速度限制。
- 視訊模式的中繼資料（目前是哪個分頁）走 DataChannel，比視訊畫面早到幾十毫秒；換分頁的瞬間點擊可能落到新分頁。
- 視訊模式要求兩端的 Chrome 有 H264（硬體編碼只在 H264 的特定參數上，其他參數會退回慢一倍的軟體編碼）。在 Apple M4 以外的機器上沒測過。

## 效能（實測）

- 截圖間隔（圖片模式與視訊模式相同）：畫面有變化時，上一張**確認送達**後依「速率」設定再截下一張（送達前不截新的，沒有備援計時器）；沒變化時每 500 ms 檢查一次並送 `same`。
- host 螢幕鎖定、負載測試頁（時鐘加持續重繪的色塊，每張約 63 KB）：剛連上約 14 到 15 fps，之後會隨 host 的系統負載降到約 9 到 11 fps（開著 macOS 螢幕共享時最明顯）；延遲額外約 +30 到 +50 ms。右上角會顯示近 5 秒的 fps 與額外延遲。間隔下限從 100 ms 降到 40 ms 前是約 9.7 fps。
- 單張成本約：截圖 20 到 45 ms、送達 45 到 70 ms。**瓶頸在頁面渲染，不在 JPEG 編碼或頻寬**：降品質到 35、開 `optimizeForSpeed` 實測都沒有變快，所以維持品質 50；也因此縮小尺寸不會更快。
- 不用 CDP `Page.startScreencast`：host 螢幕鎖定、頁面不可見時，它一張畫面都不會產生（實測 0 張），而 `Page.captureScreenshot` 不受影響。
- 不用 `chrome.tabCapture` 加 WebRTC 視訊軌：實測約 59 fps（截圖約 22 fps，同一台機器），但它要求有人先在那個分頁點過插件圖示，host 沒人在場就開不了；只有用 `--allowlisted-extension-id` 啟動 Chrome 才能繞過。各編碼的數字見 `proto-video/README.md`。
- 不用 `clip`＋`scale` 縮小截圖：它會暫時改頁面的模擬尺寸，可能干擾 AI 自己的截圖與點擊。

## 開發

原始碼在 `src/`（TypeScript，ES modules），`tsc` 逐檔編譯到 `extension/`，沒有打包工具。`extension/` 裡的 `.js` 是編譯結果，不進版本控制；`manifest.json` 與 `.html` 才是手寫的。

- `npm run build`：編譯。`npm run watch`：存檔就編譯。
- `npm run check`：只做型別檢查（含測試）。
- `npm test`：位址與網段解析的單元測試（Node 直接跑 TypeScript，不用先編譯）。
- `npm run e2e`：端對端測試。用本機的 Chrome 開一個全新設定檔（會跳出一個視窗），讓插件在同一個 Chrome 裡自己連自己，檢查畫面、滑鼠鍵盤、分頁列、結束連線。
- `npm run pack`：編譯並打包成 `cctabgaze.zip`，同時檢查包內檔案（缺檔、多檔、manifest 或 html 指到不存在的檔案、編譯結果比原始碼舊，都會失敗）。
- `npm run bump -- patch|minor|major`：調整版本號。版本號只存在 `extension/manifest.json`。
- 發版：調整版本號後推上 `main`，CI 檢查通過且這個版本還沒發過，就建立 tag `v<version>` 與 GitHub Release（附 zip）。版本號沒動的 push 只做檢查。
- 各執行環境之間的訊息格式都定義在 `src/protocol.ts`，欄位或 `type` 打錯會在編譯時報錯。viewer 經 DataChannel 送來的資料在 host 端的型別是 `unknown`，必須經過 `input()`、`tune()`、`doControl()` 的檢查才能用。

## 歷史

兩個插件交換 WebRTC 連線資訊的原型在 commit `fc8e4e6`，壓力測試版在 `8ac7fd2`（`proto-b/`，已刪除）。第 1 階段的 relay + `ssh -L` 方案在 commit `fdb1bd4`。
