#!/usr/bin/env bash
# setlog Bot を止める（自動起動の設定はそのまま。次のサーバー再起動では起動する）。
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

systemctl --user stop "$SERVICE"
show_status
