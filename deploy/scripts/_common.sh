# setlog Bot の操作スクリプトの共通部分（直接は実行しない）。
# ユーザー単位の systemd（systemctl --user）で動かしている前提（docs/deploy.md）。
set -euo pipefail

SERVICE=setlog-bot
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UNIT_SRC="$APP_DIR/deploy/setlog-bot.user.service"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_DST="$UNIT_DIR/$SERVICE.service"

# 状態を短く表示する
show_status() {
  local active enabled
  active=$(systemctl --user is-active "$SERVICE" 2>/dev/null) || true
  enabled=$(systemctl --user is-enabled "$SERVICE" 2>/dev/null) || true
  [[ -z "$enabled" || "$enabled" == "not-found" ]] && enabled="未登録"
  echo "状態: ${active:-unknown}（自動起動: $enabled）"
}

# 直近のログを表示する
show_log() {
  journalctl --user -u "$SERVICE" --no-pager -n "${1:-8}" -o cat || true
}
