/**
 * setlog からの受信（B1）を組み立てる：状態ストア＋ WebSocket ＋ REST 補完＋取り込み。
 *
 * - WebSocket がつながるたび（起動時・再接続時・/reconnect）に REST で補完する。ただし 5 分ごとの定期のつなぎ直しでは、
 *   前の補完から 10 分たったときだけ補完する（backfill-gate.ts）。記録しない失敗が残っている間は 5 分ごとにも補完する
 * - トークン失効（接続時の 401・補完中の 401）と close 4403 では受信を止めて通知する。
 *   プロセスは止めない（systemd に再起動されて setlog に接続を繰り返さないため）
 *
 * クリップは復号して clips チャンネルに（B2）、テキストは復号して chat チャンネルに（B3）、embed で投稿する。
 */
import { SetlogAuthError, SetlogClient, SetlogSchemaError } from "../lib/setlog/client";
import { fetchMedia, type Keyring } from "../lib/setlog/media";
import { createBackfillGate } from "./backfill-gate";
import { createClipHandler } from "./clips";
import type { BotConfig } from "./config";
import { createIngest } from "./ingest";
import { log } from "./log";
import { createMemberDirectory } from "./members";
import type { PostEmbed } from "./posting";
import { SendError, createSender, resolveParent, sendParts, type OutgoingPart } from "./sender";
import { createReactionSync, type ReactionSync } from "./reactions";
import { createTextHandler } from "./texts";
import { startSetlogSocket, type FatalReason, type SetlogSocket } from "./setlog-socket";
import { openState } from "./state";
import type { Notifier } from "./status";

export type Receiver = {
  stop(): Promise<void>;
  /** すぐつなぎ直す（/reconnect）。つながったら補完も走る。 */
  reconnect(): "reconnecting" | "not-connected" | "halted";
  /**
   * Discord の発言（テキストと画像・動画）を setlog に送る（B4・設計書7.4）。replyToDiscordId（Discord で返信した先）があれば、
   * 対応する setlog のメッセージへの返信として送る。送れないものがあれば、残りを送ったうえで SendError を投げる。
   */
  send(conversationId: string, parts: OutgoingPart[], discordMessageId: string, replyToDiscordId?: string): Promise<void>;
  /** Discord で友達の投稿に付け外ししたリアクションを setlog に同期する（設計書7.5）。失敗は #bot-status に知らせる。 */
  react: ReactionSync;
};

const FATAL_TEXT: Record<FatalReason, string> = {
  auth: "setlog token expired. Receiving stopped. Log in again with the email OTP and restart the bot.",
  locked: "setlog closed the connection with 4403 (the account may be locked). Receiving stopped. Check the account in the app.",
};

export function startReceiver(
  config: BotConfig,
  notify: Notifier,
  opts: { statePath: string; startedAt: number; keyring: Keyring; post: PostEmbed; retryIntervalMs?: number; backfillIntervalMs?: number },
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
  const sender = createSender({
    keyring: opts.keyring,
    myUserId: config.setlog.userId,
    getParticipantKeys: (conv) => setlog.getParticipantKeys(conv),
    getMyKey: async () => {
      const u = await setlog.getProfile();
      return { kid: u.kid, publicKey: u.publicKey };
    },
    sendTextMessage: (p) => setlog.sendTextMessage(p),
    getUploadUrl: () => setlog.getUploadUrl(),
    uploadMedia: (url, cipher) => setlog.uploadMedia(url, cipher),
    sendMediaMessage: (p) => setlog.sendMediaMessage(p),
  });
  const ingest = createIngest({
    store,
    myUserId: config.setlog.userId,
    ignoredSenderIds: config.ignoredSenderIds,
    groups: config.groups,
    handler: (m) => (m.kind === "text" ? textHandler(m) : clipHandler(m)),
    notify,
    fetchMessages: (conv, o) => setlog.getConversationMessages(conv, o),
    startedAt: opts.startedAt,
  });

  let socket: SetlogSocket | null = null;
  let halted = false;
  const react = createReactionSync({
    lookup: (id) => store.postedMessageOf(id),
    addReaction: (p) => setlog.addReaction(p),
    removeReaction: (p) => setlog.removeReaction(p),
    notify,
    isHalted: () => halted,
  });

  function halt(reason: FatalReason): void {
    if (halted) return;
    halted = true;
    socket?.stop();
    socket = null;
    void notify(FATAL_TEXT[reason]);
  }

  const gate = createBackfillGate({ intervalMs: opts.backfillIntervalMs ?? 10 * 60_000 });

  async function backfill(): Promise<void> {
    gate.markBackfilled();
    try {
      await ingest.backfill();
    } catch (e) {
      if (e instanceof SetlogAuthError) {
        log.error("REST 補完：トークン失効");
        halt("auth");
      } else if (e instanceof SetlogSchemaError) {
        log.warn(`REST 補完：形が想定と違う（${e.endpoint}）`);
        void notify("Possible API change (shape of REST messages response). Could not fetch missed messages.");
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
  }, opts.retryIntervalMs ?? 5 * 60_000);

  socket = startSetlogSocket(
    { token: config.setlog.token },
    {
      onOpen: (info) => {
        if (gate.shouldBackfill(info)) void backfill();
      },
      onFrame: (text) => ingest.onFrame(text),
      onFatal: halt,
      onDownTooLong: () => void notify("setlog WebSocket has been disconnected for over 5 minutes. Still retrying."),
      onRecovered: () => void notify("Reconnected to setlog WebSocket."),
    },
  );

  return {
    async send(conversationId, parts, discordMessageId, replyToDiscordId) {
      if (halted) throw new SendError("receiving is stopped (see #bot-status)");
      const parentId = resolveParent((id) => store.setlogMessageOf(id), replyToDiscordId, conversationId);
      const r = await sendParts(sender, conversationId, parts, { parentId });
      if (r.firstMessageId) {
        try {
          // 表は Discord の発言 1 件につき 1 行なので、最初に送れたものを記録する（返信先に使う）
          store.recordSent({ discordMessageId, setlogMessageId: r.firstMessageId, conversationId });
        } catch (e) {
          // 送信はできているので、記録の失敗では利用者に失敗を返さない
          log.warn(`送信の記録に失敗: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (r.failures.length === 0) return;
      if (r.failures.length === 1 && parts.length === 1) throw new SendError(r.failures[0].replace(/^[^:]*: /, ""));
      // main.ts が「Not sent: 」を前に付けて返信する
      const head = r.sent > 0 ? `only ${r.sent} of ${parts.length} parts were sent` : "";
      throw new SendError(`${head}\n${r.failures.map((f) => `- ${f}`).join("\n")}`);
    },
    react,
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
