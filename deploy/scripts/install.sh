#!/usr/bin/env bash
# systemd（ユーザー単位）に setlog Bot を登録し、サーバー再起動後に自動で起動するようにする。
# 起動はしない（起動は start.sh）。何度実行してもよい（ユニットファイルを置き直す）。
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

[[ -f "$UNIT_SRC" ]] || { echo "ユニットファイルが無い: $UNIT_SRC" >&2; exit 1; }
install -d -m 700 "$UNIT_DIR"
install -m 644 "$UNIT_SRC" "$UNIT_DST"
systemd-analyze --user verify "$UNIT_DST"
systemctl --user daemon-reload
systemctl --user enable "$SERVICE"

# ログアウト中・再起動後に動かすには linger が要る
if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]]; then
  echo "注意: linger が無効なので、ログアウトすると止まり、再起動後も自動では動かない。" >&2
  echo "      sudo loginctl enable-linger $USER を実行する" >&2
fi
echo "登録した: $UNIT_DST"
show_status
