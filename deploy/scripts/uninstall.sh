#!/usr/bin/env bash
# install.sh の逆：setlog Bot を止め、自動起動を外し、systemd から登録を消す。
# Bot の本体・秘密情報・状態ストア（data/）は消さない。
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

systemctl --user disable --now "$SERVICE" 2>/dev/null || true
rm -f "$UNIT_DST"
systemctl --user daemon-reload
systemctl --user reset-failed "$SERVICE" 2>/dev/null || true
echo "登録を消した（$APP_DIR はそのまま）"
show_status
