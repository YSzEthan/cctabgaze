#!/bin/sh
# 把信令伺服器裝成這台 Mac 的 launchd 常駐服務（登入後自動啟動、掛了自動重啟）。用法：scripts/install-server.sh [port]
# token 存在 ~/.config/cctabgaze/token（權限 600），不寫進 plist；要換 token 就刪掉那個檔再重跑，並更新 host 插件裡的設定。
set -eu
PORT=${1:-8790}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
CONF="$HOME/.config/cctabgaze"
LABEL=com.cctabgaze.signal
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
BUN=$(command -v bun) || { echo "找不到 bun"; exit 1; }

mkdir -p "$CONF"; chmod 700 "$CONF"
[ -f "$CONF/token" ] || { umask 077; openssl rand -hex 24 > "$CONF/token"; }
# launchd 的背景服務讀不到 ~/Desktop、~/Documents（macOS 隱私保護），所以把伺服器與網頁複製到設定資料夾再從那裡執行；改了 server/ 或 web/ 要重跑本腳本
(cd "$ROOT" && "$BUN" build web/app.ts --outfile web/app.js --target browser > /dev/null)
rm -rf "$CONF/server" "$CONF/web"; mkdir "$CONF/server" "$CONF/web"
cp "$ROOT"/server/index.ts "$ROOT"/server/relay.ts "$CONF/server/"
cp "$ROOT"/web/index.html "$ROOT"/web/app.js "$ROOT"/web/manifest.webmanifest "$ROOT"/web/*.png "$CONF/web/"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string><string>-c</string>
    <string>CG_TOKEN=\$(cat "$CONF/token") PORT=$PORT exec "$BUN" "$CONF/server/index.ts"</string>
  </array>
  <key>WorkingDirectory</key><string>$CONF/server</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$CONF/signal.log</string>
  <key>StandardErrorPath</key><string>$CONF/signal.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "已啟動 ${LABEL}，port ${PORT}。日誌：${CONF}/signal.log"
echo "token 在 ${CONF}/token，貼到 host 插件的「信令伺服器」設定"
