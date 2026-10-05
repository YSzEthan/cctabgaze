#!/usr/bin/env bash
# 把 extension/ 打包成 zip 並檢查內容。用法：scripts/pack.sh <輸出的 zip>（要先 npm run build）
set -euo pipefail
cd "$(dirname "$0")/.."
zip=${1:?用法：scripts/pack.sh <輸出的 zip>}
case "$zip" in /*) ;; *) zip="$PWD/$zip" ;; esac

# 包裡應該有的檔案：manifest、手寫的 html、每個 src/*.ts 編出來的 .js。多一個少一個都算錯
html=$(cd extension && ls *.html)
js=$(cd src && ls *.ts | grep -v '\.d\.ts$' | sed 's/\.ts$/.js/')
want=$(printf '%s\n' manifest.json $html $js | sort)

rm -f "$zip"
(cd extension && zip -qr "$zip" . -x '.*')

have=$(unzip -Z1 "$zip" | sort)
if [ "$want" != "$have" ]; then
  echo "包內檔案與預期不符（< 少了，> 多了；少 .js 多半是忘了 npm run build，多 .js 是 src 已刪掉的舊編譯結果）：" >&2
  diff <(echo "$want") <(echo "$have") >&2 || true
  exit 1
fi

# manifest 與 html 指到的檔案都要在包裡
manifest_refs=$(node -p "const m = require('./extension/manifest.json'); [m.background.service_worker, m.action.default_popup].join('\n')")
html_refs=$(grep -oh 'src="[^"]*"' extension/*.html | sed 's/^src="//; s/"$//' || true)
for f in $manifest_refs $html_refs; do
  grep -qxF "$f" <<< "$want" || { echo "manifest 或 html 指到 ${f}，但包裡沒有" >&2; exit 1; }
done

# 原始碼不能比編譯結果新（擋掉「改了 src 沒重新 build」）
for f in $js; do
  if [ "src/${f%.js}.ts" -nt "extension/$f" ]; then echo "extension/$f 比 src/${f%.js}.ts 舊，請重新 npm run build" >&2; exit 1; fi
done

unzip -tq "$zip" > /dev/null
echo "ok  $(basename "$zip")：$(wc -l <<< "$have" | tr -d ' ') 個檔案，$(wc -c < "$zip" | tr -d ' ') bytes"
