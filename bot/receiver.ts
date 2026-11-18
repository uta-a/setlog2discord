/**
 * setlog からの受信（B1）を組み立てる：状態ストア＋ WebSocket ＋ REST 補完＋取り込み。
 *
 * - WebSocket がつながるたび（起動時・再接続時）に REST で補完する。記録しない失敗が残っている間は 10 分ごとにも補完する
 * - トークン失効（接続時の 401・補完中の 401）と close 4403 では受信を止めて通知する。
 *   プロセスは止めない（systemd に再起動されて setlog に接続を繰り返さないため）
 *
 * クリップは復号して clips チャンネルに（B2）、テキストは復号して chat チャンネルに（B3）、embed で投稿する。
 */
import { SetlogAuthError, SetlogClient, SetlogSchemaError } from "../lib/setlog/client";
import { fetchMedia, type Keyring } from "../lib/setlog/media";
import { createClipHandler } from "./clips";
import type { BotConfig } from "./config";
import { createIngest } from "./ingest";
import { log } from "./log";
import { createMemberDirectory } from "./members";
import type { PostEmbed } from "./posting";
import { createTextHandler } from "./texts";
import { startSetlogSocket, type FatalReason, type SetlogSocket } from "./setlog-socket";
import { openState } from "./state";
import type { Notifier } from "./status";

export type Receiver = {
  stop(): Promise<void>;
  /** すぐつなぎ直す（/reconnect）。つながったら補完も走る。 */
  reconnect(): "reconnecting" | "not-connected" | "halted";
};

const FATAL_TEXT: Record<FatalReason, string> = {
  auth: "setlog のトークンが失効した。受信を止めた。メール OTP で再登録して、Bot を再起動する",
  locked: "setlog から close 4403（アカウントロックの可能性）。受信を止めた。アプリで状態を確かめる",
};

export function startReceiver(
  config: BotConfig,
  notify: Notifier,
  opts: { statePath: string; startedAt: number; keyring: Keyring; post: PostEmbed; retryIntervalMs?: number },
): Receiver {
  const store = openState(opts.statePath);
  const setlog = new SetlogClient({ apiKey: config.setlog.apiKey, token: config.setlog.token });
  const members = createMemberDirectory(
    async () => (await setlog.getCollections()).flatMap((c) => c.participants),
    (path) => fetchMedia(path, { maxBytes: 5 * 1024 * 1024 }),
  );
  const clipHandler = createClipHandler({
    keyring: opts.keyring,
    myUserId: config.setlog.userId,
    fetchMedia: (path) => fetchMedia(path),
    post: opts.post,
    profile: (id) => members.profile(id),
    avatar: (path) => members.avatar(path),
    notify,
  });
  const textHandler = createTextHandler({
    keyring: opts.keyring,
    myUserId: config.setlog.userId,
    post: opts.post,
    discordMessageIdOf: (id) => store.discordMessageIdOf(id),
    profile: (id) => members.profile(id),
    avatar: (path) => members.avatar(path),
    notify,
  });
  const ingest = createIngest({
    store,
    myUserId: config.setlog.userId,
    groups: config.groups,
    handler: (m) => (m.kind === "text" ? textHandler(m) : clipHandler(m)),
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

  // 記録しない失敗（CDN・投稿の一時的な失敗）が残っている間は、WebSocket が切れなくても定期的に補完する
  const retryTimer = setInterval(() => {
    if (!halted && (clipHandler.hasPending() || textHandler.hasPending())) {
      log.info("取りこぼしたメッセージを拾い直すため補完する");
      void backfill();
    }
  }, opts.retryIntervalMs ?? 10 * 60_000);

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
    reconnect() {
      if (halted || !socket) return "halted";
      return socket.reconnectNow() ? "reconnecting" : "not-connected";
    },
    async stop() {
      clearInterval(retryTimer);
      socket?.stop();
      socket = null;
      await ingest.idle();
      store.close();
    },
  };
}
