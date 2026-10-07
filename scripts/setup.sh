#!/bin/sh
# 一鍵安裝（host 那台 Mac）：裝依賴、編譯插件、把信令伺服器裝成常駐服務。用法：bun run setup [port] [--keep-token]
# 參數原樣傳給 install-server.sh。它每次執行都會換新的 token，重跑時不想換就加 --keep-token。
set -eu
cd "$(dirname "$0")/.."
bun install
bun run build
scripts/install-server.sh "$@"
echo
echo "插件：chrome://extensions → 開啟開發人員模式 → 載入未封裝項目 → 選 $PWD/extension"
echo "第一次載入會自動開啟說明頁，把伺服器位址與上面的 token 填在那裡。已經載入過的話按重新載入，設定在插件圖示的懸浮視窗。"
