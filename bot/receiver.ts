/**
 * setlog からの受信（B1）を組み立てる：状態ストア＋ WebSocket ＋ REST 補完＋取り込み。
 *
 * - WebSocket がつながるたび（起動時・再接続時）に REST で補完する
 * - トークン失効（接続時の 401・補完中の 401）と close 4403 では受信を止めて通知する。
 *   プロセスは止めない（systemd に再起動されて setlog に接続を繰り返さないため）
 *
 * B1 ではクリップ・テキストを受け取ったことをログに出すだけで、状態ストアには記録しない
 * （記録すると B2・B3 で投稿されなくなる）。
 */
import { SetlogAuthError, SetlogClient, SetlogSchemaError } from "../lib/setlog/client";
import type { BotConfig } from "./config";
import { createIngest, short, type MessageHandler } from "./ingest";
import { log } from "./log";
import { startSetlogSocket, type FatalReason, type SetlogSocket } from "./setlog-socket";
import { openState } from "./state";
import type { Notifier } from "./status";

export type Receiver = { stop(): Promise<void> };

const FATAL_TEXT: Record<FatalReason, string> = {
  auth: "setlog のトークンが失効した。受信を止めた。メール OTP で再登録して、Bot を再起動する",
  locked: "setlog から close 4403（アカウントロックの可能性）。受信を止めた。アプリで状態を確かめる",
};

/** B1 の仮ハンドラ：受け取ったことだけをログに出す。 */
const logOnly: MessageHandler = async (m) => {
  log.info(`受信 ${m.kind}（${m.group.name} msg=${short(m.message.messageId)}）`);
  return undefined;
};

export function startReceiver(
  config: BotConfig,
  notify: Notifier,
  opts: { statePath: string; startedAt: number; handler?: MessageHandler },
): Receiver {
  const store = openState(opts.statePath);
  const setlog = new SetlogClient({ apiKey: config.setlog.apiKey, token: config.setlog.token });
  const ingest = createIngest({
    store,
    myUserId: config.setlog.userId,
    groups: config.groups,
    handler: opts.handler ?? logOnly,
    notify,
    fetchMessages: (conv, o) => setlog.getConversationMessages(conv, o),
    startedAt: opts.startedAt,
  });

  let socket: SetlogSocket | null = null;
  let halted = false;

  function halt(reason: FatalReason): void {
    if (halted) return;
    halted = true;
    socket?.stop();
    socket = null;
    void notify(FATAL_TEXT[reason]);
  }

  async function backfill(): Promise<void> {
    try {
      await ingest.backfill();
    } catch (e) {
      if (e instanceof SetlogAuthError) {
        log.error("REST 補完：トークン失効");
        halt("auth");
      } else if (e instanceof SetlogSchemaError) {
        log.warn(`REST 補完：形が想定と違う（${e.endpoint}）`);
        void notify("API 仕様変更の可能性（REST messages の外側の形）。補完できなかった");
      } else {
        log.warn(`REST 補完に失敗: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  socket = startSetlogSocket(
    { token: config.setlog.token },
    {
      onOpen: () => void backfill(),
      onFrame: (text) => ingest.onFrame(text),
      onFatal: halt,
      onDownTooLong: () => void notify("setlog の WebSocket に 5 分以上つながっていない。再接続を続けている"),
      onRecovered: () => void notify("setlog の WebSocket に再接続した"),
    },
  );

  return {
    async stop() {
      socket?.stop();
      socket = null;
      await ingest.idle();
      store.close();
    },
  };
}
