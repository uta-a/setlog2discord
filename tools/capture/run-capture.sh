#!/usr/bin/env bash
# setlog 動的解析用の mitmdump 起動ラッパー。
# newchatapi.com 宛のフローを captures/raw/ に保存する（アドオン: mitm_capture.py）。
#
# 使い方:
#   tools/capture/run-capture.sh                # ポート 8080 で待ち受け
#   PORT=9090 tools/capture/run-capture.sh      # ポート変更
#   SAVE_MEDIA_BYTES=1 tools/capture/run-capture.sh   # 動画本体も保存
#
# 端末側の準備（別途・手動）:
#   1. 端末の Wi-Fi プロキシを「この Mac の IP : PORT」に設定
#   2. mitmproxy の CA を端末に導入（http://mitm.it からインストール）
#      ※ 素の setlog はユーザー CA を信頼しないが、パッチ版
#        (network_security_config に <certificates src="user"/>) なら通る
#   3. 疎通確認: 端末ブラウザで http://mitm.it が開けること
set -euo pipefail

cd "$(dirname "$0")/../.."  # リポジトリルートへ

PORT="${PORT:-8080}"
ADDON="tools/capture/mitm_capture.py"

mkdir -p captures/raw

IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo '不明')"
echo "────────────────────────────────────────────"
echo " mitmdump を起動します"
echo "   待ち受け:      0.0.0.0:${PORT}"
echo "   この Mac の IP: ${IP}"
echo "   端末プロキシに  ${IP}:${PORT}  を設定してください"
echo "   保存先:        captures/raw/"
echo "────────────────────────────────────────────"

exec mitmdump -s "$ADDON" --listen-port "$PORT" --set console_eventlog_verbosity=warn
