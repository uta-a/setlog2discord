#!/usr/bin/env bash
# setlog Bot を起動する（install.sh で登録してあること）。
# 注意：Bot は 1 か所でしか動かさない（Mac で pnpm start していないこと）。
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

# 落ち続けて systemd に止められていた場合も起動できるようにする
systemctl --user reset-failed "$SERVICE" 2>/dev/null || true
systemctl --user start "$SERVICE"
sleep 10
show_status
show_log
