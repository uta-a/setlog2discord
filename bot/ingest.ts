/**
 * setlog から届いたメッセージの取り込み（設計書4章）。WebSocket のフレームと REST の補完を同じ経路に通す。
 *
 * 1. 設定に無い会話（ソロログ・DM・別グループ）は黙って捨てる
 * 2. 送信者が自分のものは捨てる（REST の補完には自分の発言も入るため）
 * 3. クリップ・テキスト以外は捨てる
 * 4. 会話ごとに直列で処理する。messageId が処理済みなら捨て、ハンドラに渡し、結果を状態ストアに記録する
 *
 * ハンドラが undefined を返したら記録しない（B1 の仮ハンドラ用。記録すると B2・B3 で投稿されなくなる）。
 * ハンドラの例外はここで捕まえる（記録しないので、次の補完でもう一度試す）。
 *
 * REST 補完の下限：cursor が無ければプロセス起動時刻、あれば cursor の 24 時間前。直近 40 件まで。
 * ただし、その会話を Bot が見始めた時刻（watched_conversations）より前は流さない。cursor の 24 時間前だけだと、
 * 会話を設定した直後に 1 件記録しただけで、見ていなかった前日の分まで流れた（2026-11-19）。
 * ただしテキストは、B3 を始める前の分を流さない。その会話で 1 件も記録していない間は起動時刻、記録してからは
 * 初めて記録したテキストの時刻より前を流さない。
 *
 * ログと通知に本文は出さない。ID は先頭 8 文字だけ出す。
 */
import { messageKind, parseFrame, parseMessageHead, type MessageHead } from "../lib/setlog/realtime";
import type { GroupConfig } from "./config";
import { log } from "./log";
import type { Notifier } from "./status";
import type { MessageKind, ProcessResult, StateStore } from "./state";

/** photo は状態ストアには clip として記録する（表の種類の列は clip・text だけ）。 */
export type IncomingKind = MessageKind | "photo";
export type IncomingMessage = { kind: IncomingKind; group: GroupConfig; message: MessageHead };

export type HandlerResult = { result: ProcessResult; discordMessageId?: string } | undefined;
export type MessageHandler = (m: IncomingMessage) => Promise<HandlerResult>;

export type IngestOptions = {
  store: StateStore;
  myUserId: string;
  groups: GroupConfig[];
  handler: MessageHandler;
  notify: Notifier;
  /** REST：会話のメッセージを新しい順に最大 limit 件。 */
  fetchMessages: (conversationId: string, opts: { limit: number; beforeTimestamp: number }) => Promise<unknown[]>;
  /** プロセスの起動時刻（cursor が無いときの補完の下限）。 */
  startedAt: number;
  now?: () => number;
};

export type Ingest = {
  onFrame(text: string): void;
  /** 設定した全会話を REST で補完する。SetlogAuthError などはそのまま投げる。 */
  backfill(): Promise<void>;
  /** 積まれた処理がすべて終わるまで待つ。 */
  idle(): Promise<void>;
};

export const BACKFILL_LIMIT = 40;
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

export const short = (id: string) => id.slice(0, 8);

export function createIngest(opts: IngestOptions): Ingest {
  const now = opts.now ?? Date.now;
  const byConversation = new Map<string, GroupConfig>();
  for (const g of opts.groups) {
    byConversation.set(g.conversationId, g);
    byConversation.set(g.chatConversationId, g);
  }

  const queues = new Map<string, Promise<void>>();
  const notifiedSchema = new Set<string>();

  function schemaProblem(where: string, detail: string): void {
    log.warn(`setlog の形が想定と違う（${where}）: ${detail}`);
    if (notifiedSchema.has(where)) return;
    notifiedSchema.add(where);
    void opts.notify(`API 仕様変更の可能性（${where}）: ${detail}`);
  }

  /** 例外を外に出さない（会話のキューの鎖が切れて後続が飛ばないように）。 */
  async function handleOne(m: IncomingMessage): Promise<void> {
    const id = m.message.messageId;
    try {
      if (opts.store.isProcessed(id)) return;
      const r: HandlerResult = await opts.handler(m);
      if (!r) return;
      opts.store.recordProcessed({
        messageId: id,
        conversationId: m.message.conversationId,
        kind: m.kind === "text" ? "text" : "clip",
        timestamp: m.message.timestamp,
        result: r.result,
        discordMessageId: r.discordMessageId,
      });
    } catch (e) {
      log.error(`処理に失敗（${m.kind} msg=${short(id)}）: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function enqueue(message: MessageHead, source: "ws" | "rest"): void {
    const group = byConversation.get(message.conversationId);
    if (!group) return;
    if (message.senderId === opts.myUserId) return;
    const kind = messageKind(message);
    if (kind === "other") {
      log.info(`未対応の種類を無視（${source} msg=${short(message.messageId)}）`);
      return;
    }
    const conv = message.conversationId;
    const prev = queues.get(conv) ?? Promise.resolve();
    const next = prev.then(() => handleOne({ kind, group, message }));
    queues.set(conv, next);
    void next.finally(() => {
      if (queues.get(conv) === next) queues.delete(conv);
    });
  }

  /**
   * 会話を見始めた時刻。未記録なら今回の起動時刻にする。この表を足す前から見ていた会話は、
   * 記録済みのいちばん古いメッセージの時刻までさかのぼる（それより前は見ていた証拠が無い）。
   */
  function watchStartOf(conv: string): number {
    const known = opts.store.watchStart(conv);
    if (known !== null) return known;
    const firsts = [opts.store.firstProcessedTimestamp(conv, "clip"), opts.store.firstProcessedTimestamp(conv, "text")];
    const since = Math.min(opts.startedAt, ...firsts.filter((t): t is number => t !== null));
    opts.store.ensureWatchStart(conv, since);
    return since;
  }

  return {
    onFrame(text) {
      const f = parseFrame(text);
      if (f.kind === "invalid") {
        schemaProblem(`WebSocket ${f.action ?? "(action 不明)"}`, f.detail);
        return;
      }
      if (f.kind === "other") {
        log.info(`setlog WebSocket：${f.action} は無視`);
        return;
      }
      enqueue(f.message, "ws");
    },

    async backfill() {
      const conversations = [...byConversation.keys()];
      for (const conv of conversations) {
        const raw = await opts.fetchMessages(conv, { limit: BACKFILL_LIMIT, beforeTimestamp: now() });
        const cursor = opts.store.getCursor(conv);
        const watchStart = watchStartOf(conv);
        const lowerBound = Math.max(cursor === null ? opts.startedAt : cursor - LOOKBACK_MS, watchStart);
        // テキストの転送（B3）を始める前の分は流さない。テキストを 1 件も記録していない間は起動時刻、
        // 記録してからは初めて記録したテキストの時刻を下限にする（cursor の 24 時間前まで広げても、B3 以前には戻らない）
        const firstText = opts.store.firstProcessedTimestamp(conv, "text");
        const textBound = Math.max(lowerBound, firstText ?? opts.startedAt);
        const messages: MessageHead[] = [];
        for (const item of raw) {
          const p = parseMessageHead(item);
          if (!p.success) {
            schemaProblem("REST messages", p.error.issues.map((i) => i.path.join(".") || "(root)").join(", "));
            continue;
          }
          const bound = messageKind(p.data) === "text" ? textBound : lowerBound;
          if (p.data.timestamp >= bound) messages.push(p.data);
        }
        messages.sort((a, b) => a.timestamp - b.timestamp);
        for (const m of messages) enqueue(m, "rest");
      }
    },

    async idle() {
      while (queues.size > 0) await Promise.all([...queues.values()]);
    },
  };
}
