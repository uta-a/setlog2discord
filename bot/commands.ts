/**
 * スラッシュコマンドの定義。登録は起動時には行わない（Discord に一度登録すれば残る。起動のたびに登録すると、
 * 再起動を繰り返したときに頻度制限で起動が数十秒遅れた）。中身を変えたら tools/register-commands.ts で登録し直す。
 */
import { InteractionContextType, PermissionFlagsBits } from "discord.js";

/** setlog にすぐつなぎ直すコマンド（スマホのアプリに配信先を取られたとき用）。 */
export const RECONNECT_COMMAND = {
  name: "reconnect",
  description: "setlog にすぐつなぎ直す（取りこぼし分も補完する）",
  // サーバー管理者だけに見せる（実際に使えるのは ownerUserId だけ）
  defaultMemberPermissions: PermissionFlagsBits.Administrator,
  contexts: [InteractionContextType.Guild],
};

export const COMMANDS = [RECONNECT_COMMAND];
