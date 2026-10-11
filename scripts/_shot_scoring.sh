#!/usr/bin/env bash
# 发牌视图实拍：**单张**。每次 bash 调用只跑一张（后台进程活不过一次调用）。
#
# 用法: bash scripts/_shot_scoring.sh <pauseat> <out.png> [scan]
#   pauseat 0 = 冻在扫描阶段（六摞还是虚线空堆）
#   scan     = 传 "scan" 则冻在扫描阶段（等价 pauseat=0）
set -u
NODE="C:/Users/apple/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
N="${1:?用法: _shot_scoring.sh <pauseat> <out.png>}"
OUT="$HERE/${2:?用法: _shot_scoring.sh <pauseat> <out.png>}"
mkdir -p "$(dirname "$OUT")"
PORT=$(( 7600 + (RANDOM % 300) ))

if [ "$N" = "0" ]; then
  # 扫描阶段：scanfor 拉到 10 分钟 = 永远不会进打分
  "$NODE" "$HERE/scripts/_stub_board.mjs" --port "$PORT" --ms 220 --scanfor 600000 \
    > "$HERE/.workbuddy/tmp/stub_$PORT.log" 2>&1 &
  STUB=$!
  "$NODE" -e "setTimeout(function(){},2200)" >/dev/null 2>&1
  "$NODE" "$HERE/scripts/_cdp.mjs" "http://127.0.0.1:$PORT/board.html" \
    --w 1440 --h 1000 --timeout 20000 --errors \
    --preurl 1200 --wait "document.getElementById('scDeck').children.length===6 && document.getElementById('scDone').textContent==='0/0'" \
    --shot "$OUT" --evaltmplfile "$HERE/scripts/_probe_scoring.js"
else
  "$NODE" "$HERE/scripts/_stub_board.mjs" --port "$PORT" --ms 200 --pauseat "$N" \
    > "$HERE/.workbuddy/tmp/stub_$PORT.log" 2>&1 &
  STUB=$!
  "$NODE" -e "setTimeout(function(){},2200)" >/dev/null 2>&1
  # 等到**这一手真的发完**（done = N*8），别在第一手就截图 ——
  # --wait 是轮询，第一手一出现就命中，量到的永远是第1 手。
  "$NODE" "$HERE/scripts/_cdp.mjs" "http://127.0.0.1:$PORT/board.html" \
    --w 1440 --h 1000 --timeout 30000 --errors \
    --preurl 1200 \
    --wait "document.getElementById('scDone') && document.getElementById('scDone').textContent==='$(( N * 8 ))/48'" \
    --shot "$OUT" --evaltmplfile "$HERE/scripts/_probe_scoring.js"
fi
kill $STUB >/dev/null 2>&1
echo "done -> $OUT"