/**
 * 状態ストア（設計書8章）。node:sqlite で 1 ファイル（既定 data/state.sqlite）に持つ。
 *
 * - processed_messages：処理した setlog のメッセージ。未処理かどうかは messageId だけで判定する（設計書4章）
 * - sent_messages：Discord から送った発言と setlog の messageId の対応（B4 で使う）
 * - cursors：会話ごとの最後に処理した timestamp。REST 補完の下限を決めるのにだけ使う
 *
 * メッセージ本文は保存しない。
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type MessageKind = "clip" | "text";
export type ProcessResult = "posted" | "skipped" | "failed";

export type ProcessedRecord = {
  messageId: string;
  conversationId: string;
  kind: MessageKind;
  timestamp: number;
  result: ProcessResult;
  discordMessageId?: string;
};

export type StateStore = {
  isProcessed(messageId: string): boolean;
  /** 記録と cursor の更新を 1 トランザクションで行う。同じ messageId の 2 回目は無視する。 */
  recordProcessed(r: ProcessedRecord): void;
  getCursor(conversationId: string): number | null;
  /** その会話でその種類のメッセージを 1 件でも記録したことがあるか。 */
  hasProcessedKind(conversationId: string, kind: MessageKind): boolean;
  /** その会話でその種類を記録したメッセージのうち、いちばん古い timestamp（B3 を始めた時点の目安）。 */
  firstProcessedTimestamp(conversationId: string, kind: MessageKind): number | null;
  /** 投稿済みの setlog のメッセージに対応する Discord のメッセージ ID（返信の組み立てに使う）。 */
  discordMessageIdOf(messageId: string): string | undefined;
  /** Discord から setlog に送った発言を記録する（同じ Discord の発言の 2 回目は無視）。 */
  recordSent(r: { discordMessageId: string; setlogMessageId: string; conversationId: string }): void;
  sentMessageIdOf(discordMessageId: string): string | undefined;
  close(): void;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS processed_messages (
  message_id         TEXT PRIMARY KEY,
  conversation_id    TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('clip', 'text')),
  timestamp          INTEGER NOT NULL,
  discord_message_id TEXT,
  result             TEXT NOT NULL CHECK (result IN ('posted', 'skipped', 'failed')),
  processed_at       INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sent_messages (
  discord_message_id TEXT PRIMARY KEY,
  setlog_message_id  TEXT NOT NULL,
  conversation_id    TEXT NOT NULL,
  sent_at            INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cursors (
  conversation_id TEXT PRIMARY KEY,
  last_timestamp  INTEGER NOT NULL
);
`;

export function openState(path: string): StateStore {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);

  const selectProcessed = db.prepare("SELECT 1 FROM processed_messages WHERE message_id = ?");
  const insertProcessed = db.prepare(
    `INSERT OR IGNORE INTO processed_messages
       (message_id, conversation_id, kind, timestamp, discord_message_id, result, processed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const upsertCursor = db.prepare(
    `INSERT INTO cursors (conversation_id, last_timestamp) VALUES (?, ?)
     ON CONFLICT (conversation_id) DO UPDATE SET last_timestamp = MAX(last_timestamp, excluded.last_timestamp)`,
  );
  const selectCursor = db.prepare("SELECT last_timestamp FROM cursors WHERE conversation_id = ?");
  const selectKind = db.prepare("SELECT 1 FROM processed_messages WHERE conversation_id = ? AND kind = ? LIMIT 1");
  const selectFirst = db.prepare("SELECT MIN(timestamp) AS first FROM processed_messages WHERE conversation_id = ? AND kind = ?");
  const insertSent = db.prepare(
    `INSERT OR IGNORE INTO sent_messages (discord_message_id, setlog_message_id, conversation_id, sent_at) VALUES (?, ?, ?, ?)`,
  );
  const selectSent = db.prepare("SELECT setlog_message_id FROM sent_messages WHERE discord_message_id = ?");
  const selectDiscordId = db.prepare(
    "SELECT discord_message_id FROM processed_messages WHERE message_id = ? AND result = 'posted'",
  );

  return {
    isProcessed: (messageId) => selectProcessed.get(messageId) !== undefined,
    recordProcessed(r) {
      db.exec("BEGIN");
      try {
        insertProcessed.run(
          r.messageId,
          r.conversationId,
          r.kind,
          r.timestamp,
          r.discordMessageId ?? null,
          r.result,
          Date.now(),
        );
        upsertCursor.run(r.conversationId, r.timestamp);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    getCursor(conversationId) {
      const row = selectCursor.get(conversationId) as { last_timestamp: number } | undefined;
      return row ? Number(row.last_timestamp) : null;
    },
    hasProcessedKind: (conversationId, kind) => selectKind.get(conversationId, kind) !== undefined,
    firstProcessedTimestamp(conversationId, kind) {
      const row = selectFirst.get(conversationId, kind) as { first: number | null } | undefined;
      return row?.first == null ? null : Number(row.first);
    },
    discordMessageIdOf(messageId) {
      const row = selectDiscordId.get(messageId) as { discord_message_id: string | null } | undefined;
      return row?.discord_message_id ?? undefined;
    },
    recordSent(r) {
      insertSent.run(r.discordMessageId, r.setlogMessageId, r.conversationId, Date.now());
    },
    sentMessageIdOf(discordMessageId) {
      const row = selectSent.get(discordMessageId) as { setlog_message_id: string } | undefined;
      return row?.setlog_message_id;
    },
    close: () => db.close(),
  };
}
