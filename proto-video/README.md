# proto-video：chrome.tabCapture 加 WebRTC 視訊軌

實驗，不是產品的一部分。問題是：把現在的「debugger 連續截圖 + DataChannel」換成「`chrome.tabCapture` + WebRTC 視訊軌」，能不能用、會快多少。

```
bun proto-video/run.ts            # 全部跑一輪，約 3.5 分鐘，會跳出 Chrome 視窗；結果寫到 results.json
ONLY=640034 bun proto-video/run.ts          # 只跑 fmtp 含這段字的編碼
LOCK=1 ONLY=640034 bun proto-video/run.ts   # 另外留 15 秒讓你手動鎖定螢幕，量鎖定時的表現
```

## 結論

1. **沒有人在場就開不了。** `tabCapture.getMediaStreamId` 要求使用者先在「那一個分頁」點過插件圖示，否則回 `Extension has not been invoked for the current page`。點過之後，換到別的分頁不行、同一個分頁導向別的網站後也不行（都要再點一次）。host 是無人在場、AI 會自己換分頁和導向的機器，所以正常啟動的 Chrome 上這條路走不通。
2. **唯一的繞法是啟動旗標。** host 的 Chrome 用 `--allowlisted-extension-id=offomejgoflopledfnhhkdldnhfejgjl` 啟動，就不需要點圖示。代價是 host 要改啟動方式，「兩台都只要裝插件」這個前提就沒了。
3. **能開的話，快很多。** 同一台機器、同一個測試頁：視訊軌約 59 fps，現在的截圖方案約 22 fps。延遲沒有比較好（視訊 p50 約 25 到 35 ms，截圖約 15 ms），因為視訊多了接收端的緩衝。
4. **螢幕鎖定、分頁在背景、視窗最小化都不影響**，一樣約 59 fps。`Page.startScreencast` 當初就是在螢幕鎖定下一張都不出，`tabCapture` 沒有這個問題。

## 各編碼（分頁在前景）

環境：Apple M4、Chrome 154.0.8037.98、分頁 1280×756（devicePixelRatio 1）、上限 60 fps／8 Mbps、每個編碼暖機 3 秒後量 8 秒。兩個 RTCPeerConnection 都在同一份 offscreen 文件裡，**不含真實網路**。延遲是從測試頁繪製到接收端解碼完成（讀畫面上的時間條碼）。

| 編碼 | 編碼器 | 硬體 | fps | 延遲 p50／p95 (ms) | kbps | 編碼 ms／張 |
|---|---|---|---|---|---|---|
| H264 baseline `42001f` pm=1 | VideoToolbox | 是 | 59.4 | 25／34 | 2693 | 4.8 |
| H264 main `4d001f` pm=1 | VideoToolbox | 是 | 59.2 | 35／43 | 1424 | 4.1 |
| H264 high `640034` pm=1 | VideoToolbox | 是 | 59.4 | 34／44 | 1447 | 4.6 |
| H265 main `profile-id=1` | VideoToolbox | 是 | 59.2 | 35／44 | 1675 | 5.3 |
| VP8 | libvpx | 否 | 59.2 | 28／36 | 2183 | 2.1 |
| VP9 profile 0 | libvpx | 否 | 58.1 | 29／36 | 1687 | 4.7 |
| VP9 profile 2 | libvpx | 否 | 57.7 | 31／38 | 1873 | 5.2 |
| AV1 profile 0 | libaom | 否 | 56.5 | 23／110 | 4953 | 2.6 |
| H264 constrained baseline `42e01f` pm=1 | OpenH264 | 否 | 35.1 | 82／93 | 1461 | 28.2 |
| H264 baseline `42001f` pm=0 | OpenH264 | 否 | 34.0 | 81／92 | 1796 | 29.3 |
| H264 constrained baseline `42e01f` pm=0 | OpenH264 | 否 | 34.0 | 81／93 | 1814 | 29.2 |
| H264 main `4d001f` pm=0 | OpenH264 | 否 | 32.2 | 83／94 | 1756 | 30.6 |
| 對照：現行截圖（JPEG 品質 50，`bun run e2e`） | — | — | 約 22 | 15／21 | — | — |

pm 是 `packetization-mode`。「硬體」取自 WebRTC 統計的 `powerEfficientEncoder`。

- 硬體編碼只有 H264（`packetization-mode=1` 的 baseline、main、high）和 H265。VP8、VP9、AV1 在這台都是軟體編碼，但 1280×756 下一樣跑得到近 60 fps。
- **H264 選錯參數會掉到軟體的 OpenH264**：`packetization-mode=0` 全部、以及 constrained baseline，只有約 34 fps、延遲約 80 ms。要用 H264 就得明確指定硬體那幾組。
- AV1 位元率最高、p95 延遲不穩（110 ms）。
- 硬體編碼器第一張畫面要等 3 秒以上才出來，軟體的幾乎立刻。

## 情境（H264 baseline pm=1，硬體）

| 情境 | fps | 延遲 p50／p95 (ms) |
|---|---|---|
| 分頁在背景（同視窗有別的作用中分頁） | 59.2 | 34／44 |
| 視窗最小化 | 59.4 | 32／40 |

螢幕鎖定（執行前用 `ioreg` 確認 `CGSSessionScreenIsLocked` 為 true，H264 high pm=1，硬體）：

| 情境 | fps | 延遲 p50／p95 (ms) |
|---|---|---|
| 鎖定＋分頁在前景 | 59.4 | 29／34 |
| 鎖定＋分頁在背景 | 59.1 | 30／39 |
| 鎖定＋視窗最小化 | 58.9 | 32／41 |
| 對照：鎖定下的現行截圖 | 約 22 | 15／29 |

上面各編碼那張表執行時沒有記錄螢幕是否鎖定。

## 還沒驗證的

- 真實網路（Tailscale）下的延遲與掉幀；這裡量的只有擷取、編碼、解碼。
- Retina（devicePixelRatio 2）下的解析度與 fps。
- 已經開始的擷取，在分頁導向別的網站之後會不會繼續（這裡只測了「導向之後重新要求」會被拒絕）。
- 位址過濾：視訊軌和 DataChannel 走同一條 ICE 連線，`keepAllowed` 與 `checkPair` 應該照樣適用，但沒有實測。

---

# 第二個實驗：截圖擷取 + 視訊編碼傳輸（`shot.ts`）

```
bun proto-video/shot.ts                 # 約 1.5 分鐘；結果寫到 results-shot.json
ONLY='JPEG 90 → H264' bun proto-video/shot.ts
```

擷取照舊用 debugger 的 `Page.captureScreenshot`（**不用點圖示、不用啟動旗標**），但不再一張張送圖片：背景程式把截圖丟給 offscreen，解碼成 `VideoFrame` 寫進 `MediaStreamTrackGenerator`，再走 WebRTC 視訊軌。

## 結論：可行

- **fps 等於截圖的速度**，約 33 到 37 fps（每張截圖約 27 到 30 ms）；編碼只要約 4 ms，不是瓶頸。
- **頻寬是圖片的 1/4 到 1/8**：同樣的畫面、同樣的 fps，視訊約 1.1 到 1.5 Mbps，逐張送 JPEG 要 5.7 到 8.2 Mbps。
- **延遲** p50 約 27 到 40 ms。
- **整輪都在螢幕鎖定下跑的**（開始與結束時 `CGSSessionScreenIsLocked` 都是 Yes）。

| 截圖格式 → 編碼 | fps | 截圖 ms／張 | 延遲 p50／p95 (ms) | 視訊 kbps | 同樣的圖逐張送 kbps | 編碼 ms／張 |
|---|---|---|---|---|---|---|
| JPEG 50 → H264 high pm=1 | 36.7 | 27.1 | 27／39 | 1446 | 5659 | 4.1 |
| JPEG 90 → H264 high pm=1 | 33.1 | 30.1 | 39／53 | 1071 | 8212 | 4.1 |
| PNG → H264 high pm=1 | 33.0 | 30.1 | 37／51 | 747 | 7535 | 4.1 |
| WebP 90 → H264 high pm=1 | 19.2 | 51.9 | 54／81 | 602 | 1513 | 3.9 |
| JPEG 90 → H265 | 32.7 | 30.4 | 40／53 | 1124 | 8107 | 4.8 |
| JPEG 90 → VP8 | 33.0 | 30.2 | 33／46 | 1328 | 8246 | 1.6 |
| JPEG 90 → H264（分頁在背景） | 46.2 | 21.4 | 29／40 | 1503 | 11552 | 4.3 |

環境同上（M4、Chrome 154、1280×757、兩端同機、不含真實網路）。截圖是一張接一張不等待。

## 踩到的兩個坑

1. **寬高要裁成偶數。** 截圖是 1280×757，奇數高度會讓 H264 每張編碼變成 20 到 30 ms、延遲 54 到 82 ms（和第一個實驗裡軟體 OpenH264 的數字一樣）；裁成 1280×756 後回到約 4 ms。
2. **要設 `contentHint = 'detail'`。** 沒設的話 H264 會因為頻寬估計還沒爬上來而把畫面縮成 960×567。

## 限制與沒驗證的

- 這裡的 WebRTC 統計不提供 `encoderImplementation`（Chrome 只在有擷取權限的頁面才給），所以「硬體編碼」是從每張 4 ms 的編碼時間推斷的，不是直接讀到的。
- 畫質沒有量：截圖先被 JPEG 壓一次、再被視訊壓一次。PNG 可以避開第一次壓縮，速度和 JPEG 90 一樣。
- WebP 截圖本身就慢（52 ms／張），不適合。
- 測試頁每個影格都整片變色，是最吃頻寬的情況；一般網頁靜止時視訊的位元率會更低。
- 真實網路（Tailscale）沒測。
