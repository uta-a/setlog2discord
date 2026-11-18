/**
 * setlog API クライアント。setlog を知っているのはこのモジュールだけ。
 *
 * 動的解析（フェーズ0）で確定したこと：
 * - 認証は `jwt-key` のみ必須。`x-api-key` は /collections では不要だが、
 *   login 系では必要な可能性があるため常に送る。署名・端末証明なし。
 * - トークンに期限もローテーションも無い。失効（401）したら回復できないので
 *   「再登録が必要」として投げ、管理画面でメール OTP をやり直す。
 * - レスポンスは zod で検証し、形が変わったら SetlogSchemaError にする。
 *
 * 秘匿値（x-api-key の実値・トークン）はコードに埋め込まず、呼び出し側が
 * SetlogConfig で渡す（環境変数 / KV 由来）。
 */
import { z } from "zod";
import {
  CalendarResponseSchema,
  CollectionsResponseSchema,
  ConversationsResponseSchema,
  LoginResponseSchema,
  MessagesResponseSchema,
  ParticipantKeysResponseSchema,
  ProfileResponseSchema,
  SendMessageResponseSchema,
  type CalendarResponse,
  type Collection,
  type Message,
  type ParticipantKey,
  type User,
} from "./schema";
import type { Envelope, MessageKeyEntry } from "./crypto";

export const SETLOG_BASE_URL = "https://api.newchatapi.com";

export type SetlogConfig = {
  /** API Gateway の固定キー（40 文字）。実値は環境変数から。 */
  apiKey: string;
  /** user.token。認証必須 API に `jwt-key` として送る。 */
  token?: string;
  /** 基底 URL（テスト差し替え用）。 */
  baseUrl?: string;
  /** 最小リクエスト間隔(ms)。アプリ並みに抑える。既定 1000。 */
  minIntervalMs?: number;
  fetchImpl?: typeof fetch;
};

/** トークン失効。自動回復できないので再登録フローへ。 */
export class SetlogAuthError extends Error {
  constructor(message = "setlog トークンが失効。メール OTP で再登録が必要") {
    super(message);
    this.name = "SetlogAuthError";
  }
}

/** レスポンスの形が想定と違う＝API 仕様変更の疑い。 */
export class SetlogSchemaError extends Error {
  constructor(
    public readonly endpoint: string,
    public readonly issues: unknown,
  ) {
    super(`setlog レスポンスがスキーマ不一致: ${endpoint}`);
    this.name = "SetlogSchemaError";
  }
}

/** HTTP エラー（401 以外）。 */
export class SetlogHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly endpoint: string,
    public readonly body: string,
  ) {
    super(`setlog HTTP ${status}: ${endpoint}`);
    this.name = "SetlogHttpError";
  }
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 指定日(YYYY-MM-DD)の現地 04:00 起点の [start, end) を ms で返す。 */
export function dayInterval(date: string): { start: number; end: number } {
  const [y, m, d] = date.split("-").map(Number);
  // JST 04:00 の UTC ms。Asia/Tokyo は UTC+9 固定。
  const start = Date.UTC(y, m - 1, d, 4, 0) - JST_OFFSET_MS;
  return { start, end: start + DAY_MS };
}

export class SetlogClient {
  private readonly baseUrl: string;
  private readonly minIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private lastRequestAt = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: SetlogConfig) {
    this.baseUrl = config.baseUrl ?? SETLOG_BASE_URL;
    this.minIntervalMs = config.minIntervalMs ?? 1000;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  // --- 内部：レート制限付き GET/POST ----------------------------------

  private async throttle(): Promise<void> {
    const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = Date.now();
  }

  /** 直列化してレート制限を守る。 */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(() => fn());
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private headers(withAuth: boolean): Record<string, string> {
    const h: Record<string, string> = {
      "x-api-key": this.config.apiKey,
      "Content-Type": "application/json",
    };
    if (withAuth) {
      if (!this.config.token) throw new SetlogAuthError("トークン未設定");
      h["jwt-key"] = this.config.token;
    }
    return h;
  }

  private async request<T>(
    endpoint: string,
    schema: z.ZodType<T>,
    init: RequestInit & { withAuth?: boolean } = {},
  ): Promise<T> {
    return this.serialize(async () => {
      await this.throttle();
      const { withAuth = true, ...rest } = init;
      const res = await this.fetchImpl(`${this.baseUrl}${endpoint}`, {
        ...rest,
        headers: { ...this.headers(withAuth), ...(rest.headers as Record<string, string>) },
      });
      if (res.status === 401) throw new SetlogAuthError();
      if (!res.ok) {
        throw new SetlogHttpError(res.status, endpoint, await res.text().catch(() => ""));
      }
      const json = await res.json();
      const parsed = schema.safeParse(json);
      if (!parsed.success) throw new SetlogSchemaError(endpoint, parsed.error.issues);
      return parsed.data;
    });
  }

  // --- 認証 ------------------------------------------------------------

  /** メール OTP 開始。bot 対策・レート制限はサーバー側判定。 */
  async loginStart(email: string, language = "ja"): Promise<void> {
    await this.request("/auth/email/login/start", z.object({}).passthrough(), {
      method: "POST",
      body: JSON.stringify({ email, language }),
      withAuth: false,
    });
  }

  /** メール OTP 検証。応答の user.token を保存して使う。 */
  async loginVerify(email: string, code: string, language = "ja"): Promise<User> {
    const r = await this.request("/auth/email/login/verify", LoginResponseSchema, {
      method: "POST",
      body: JSON.stringify({ email, code, language }),
      withAuth: false,
    });
    return r.user;
  }

  /** プロフィール。token は返らない（ローテーションしない）ので有効性確認に使う。 */
  async getProfile(): Promise<User> {
    const r = await this.request("/user/profile", ProfileResponseSchema, { method: "GET" });
    return r.user;
  }

  // --- データ ----------------------------------------------------------

  /** グループ一覧（ソロログ含む）。DM は含まれない。 */
  async getCollections(): Promise<Collection[]> {
    const r = await this.request("/collections", CollectionsResponseSchema, { method: "GET" });
    return r.collections;
  }

  /** 月内の投稿がある日。件数は返らない。month は 1-12。 */
  async getCalendar(
    collectionId: string,
    year: number,
    month: number,
    timeZone = "Asia/Tokyo",
  ): Promise<CalendarResponse> {
    const q = new URLSearchParams({ year: String(year), month: String(month), timeZone });
    return this.request(
      `/collection/${collectionId}/messageDaysInMonth?${q}`,
      CalendarResponseSchema,
      { method: "GET" },
    );
  }

  /** 指定日(YYYY-MM-DD)のメッセージ。現地 04:00 起点の日レンジで取る。 */
  async getDayMessages(collectionId: string, date: string): Promise<Message[]> {
    const { start, end } = dayInterval(date);
    const q = new URLSearchParams({
      startTimeInterval: String(start),
      endTimeInterval: String(end),
    });
    const r = await this.request(
      `/chat/${collectionId}/messages?${q}`,
      MessagesResponseSchema,
      { method: "GET" },
    );
    return r.messages;
  }

  // --- テキストチャット -----------------------------------------------

  /** 会話（DM）一覧。 */
  async getConversations(): Promise<{ id: string }[]> {
    const r = await this.request("/chat/conversations", ConversationsResponseSchema, { method: "GET" });
    return r.conversations;
  }

  /**
   * 会話のメッセージ（フィード）。`limit` と任意の `beforeTimestamp` でページング。
   * zod は緩め（text/media が混在するため Message スキーマで受けず生で返す）。
   */
  async getConversationMessages(
    conversationId: string,
    opts: { limit?: number; beforeTimestamp?: number } = {},
  ): Promise<unknown[]> {
    const q = new URLSearchParams({ limit: String(opts.limit ?? 40) });
    if (opts.beforeTimestamp) q.set("beforeTimestamp", String(opts.beforeTimestamp));
    const r = await this.request(
      `/chat/${conversationId}/messages?${q}`,
      z.object({ success: z.boolean(), messages: z.array(z.unknown()) }),
      { method: "GET" },
    );
    return r.messages;
  }

  /** 会話の参加者の公開鍵＋kid（送信時の鍵ラップに使う）。 */
  async getParticipantKeys(conversationId: string): Promise<ParticipantKey[]> {
    const q = new URLSearchParams({ conversationId });
    const r = await this.request(
      `/chat/message/participantKeys?${q}`,
      ParticipantKeysResponseSchema,
      { method: "GET" },
    );
    return r.participants;
  }

  /**
   * テキストメッセージを送信する（POST /chat/{conversationId}/message）。
   * envelope / keys は crypto.encryptText で作る。**アカウントへの書き込み。**
   */
  async sendTextMessage(params: {
    conversationId: string;
    messageId: string;
    envelope: Envelope;
    keys: MessageKeyEntry[];
    refreshesStaleKeys?: boolean;
  }): Promise<string> {
    const body = {
      type: "chat",
      conversationId: params.conversationId,
      messageId: params.messageId,
      uuid: crypto.randomUUID(),
      refreshesStaleKeys: params.refreshesStaleKeys ?? true,
      contentType: "text/plain",
      keys: params.keys,
      envelope: params.envelope,
    };
    const r = await this.request(
      `/chat/${params.conversationId}/message`,
      SendMessageResponseSchema,
      { method: "POST", body: JSON.stringify(body) },
    );
    return r.messageId;
  }
}

/** 環境変数から設定を組む（Route Handlers / Workers 用）。 */
export function configFromEnv(
  env: Record<string, string | undefined>,
  token?: string,
): SetlogConfig {
  const apiKey = env.SETLOG_X_API_KEY;
  if (!apiKey) throw new Error("SETLOG_X_API_KEY が未設定");
  return { apiKey, token };
}
