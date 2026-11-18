#!/usr/bin/env bash
# setlog Bot を再起動する（設定や秘密情報を差し替えたあとなど）。
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

systemctl --user reset-failed "$SERVICE" 2>/dev/null || true
systemctl --user restart "$SERVICE"
sleep 10
show_status
show_log
