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

/**
 * メディアを置くリージョン。アプリは端末のロケールの国で決め、JP・KR などアジアは ap-northeast-2、
 * それ以外は us-east-1（yn3.a）。この Bot の持ち主は日本なので固定する（受信した写真・動画の media.region も ap-northeast-2）。
 */
export const MEDIA_REGION = "ap-northeast-2";

/** アップロード URL を発行する API の基底。ap-northeast-2 だけ別ホスト（yn3.b）。 */
export function mediaApiBaseUrl(region: string): string {
  return region.toLowerCase() === "ap-northeast-2" ? "https://api-kr.newchatapi.com/media" : "https://api.newchatapi.com/media";
}

/** 送れる画像・動画の MIME。アプリが拡張子を知っているもの（i31）のうち、Discord から来るもの。 */
export const SENDABLE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp", "video/mp4", "video/quicktime"] as const;
export type SendableMediaType = (typeof SENDABLE_MEDIA_TYPES)[number];

/** getUploadURL の応答。API Gateway の形で body に JSON 文字列が入って返ることもある（vb1.E）。 */
const UploadUrlResponseSchema = z
  .object({ uploadUrl: z.string().min(1).optional(), url: z.string().min(1).optional(), region: z.string().min(1), key: z.string().min(1) })
  .loose()
  .refine((r) => r.uploadUrl ?? r.url, { message: "uploadUrl が無い" });

export type SetlogConfig = {
  /** API Gateway の固定キー（40 文字）。実値は環境変数から。 */
  apiKey: string;
  /** user.token。認証必須 API に `jwt-key` として送る。 */
  token?: string;
  /** 基底 URL（テスト差し替え用）。 */
  baseUrl?: string;
  /** アップロード URL を発行する API の基底（テスト差し替え用）。既定はリージョンで決める（mediaApiBaseUrl）。 */
  mediaApiBaseUrl?: string;
  /** 最小リクエスト間隔(ms)。アプリ並みに抑える。既定 1000。 */
  minIntervalMs?: number;
  /** 1 リクエストの上限(ms)。直列なので 1 本が固まると後続がすべて止まる。既定 30000。 */
  timeoutMs?: number;
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
    return this.call(`${this.baseUrl}${endpoint}`, endpoint, init, async (res) => {
      const parsed = schema.safeParse(await res.json());
      if (!parsed.success) throw new SetlogSchemaError(endpoint, parsed.error.issues);
      return parsed.data;
    });
  }

  /** 直列化・レート制限・認証ヘッダー・401 と HTTP エラーの判定までを行い、2xx の応答を read に渡す。 */
  private async call<T>(
    url: string,
    endpoint: string,
    init: RequestInit & { withAuth?: boolean },
    read: (res: Response) => Promise<T>,
  ): Promise<T> {
    return this.serialize(async () => {
      await this.throttle();
      const { withAuth = true, ...rest } = init;
      const res = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 30_000),
        ...rest,
        headers: { ...this.headers(withAuth), ...(rest.headers as Record<string, string>) },
      });
      if (res.status === 401) throw new SetlogAuthError();
      if (!res.ok) {
        throw new SetlogHttpError(res.status, endpoint, await res.text().catch(() => ""));
      }
      return read(res);
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
    /** 返信先の messageId。アプリは空でなければ本文に入れる（gf1.java:44-51。暗号の AAD には入らない）。 */
    parentId?: string;
  }): Promise<string> {
    const body = {
      type: "chat",
      conversationId: params.conversationId,
      messageId: params.messageId,
      uuid: crypto.randomUUID(),
      refreshesStaleKeys: params.refreshesStaleKeys ?? true,
      ...(params.parentId?.trim() ? { parentId: params.parentId } : {}),
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

  // --- 画像・動画の送信 -------------------------------------------------

  /**
   * 暗号化したメディアの置き場所を発行してもらう（POST {media API}/getUploadURL、vb1.E）。
   * 返る key が media.path に、region が media.region になる。
   */
  async getUploadUrl(region = MEDIA_REGION): Promise<{ uploadUrl: string; region: string; key: string }> {
    const endpoint = "/media/getUploadURL";
    const base = this.config.mediaApiBaseUrl ?? mediaApiBaseUrl(region);
    return this.call(
      `${base}/getUploadURL`,
      endpoint,
      { method: "POST", body: JSON.stringify({ contentType: "application/octet-stream", region, encrypted: true }) },
      async (res) => {
        let json: unknown = await res.json();
        // API Gateway のプロキシ形式（{ body: "<JSON 文字列>" }）なら中身を使う
        if (json && typeof json === "object" && typeof (json as { body?: unknown }).body === "string") {
          try {
            json = JSON.parse((json as { body: string }).body);
          } catch {
            // 文字列が JSON でなければ外側をそのまま検証する
          }
        }
        const parsed = UploadUrlResponseSchema.safeParse(json);
        if (!parsed.success) throw new SetlogSchemaError(endpoint, parsed.error.issues);
        const uploadUrl = (parsed.data.uploadUrl ?? parsed.data.url)!;
        let u: URL;
        try {
          u = new URL(uploadUrl);
        } catch {
          throw new SetlogSchemaError(endpoint, [{ message: "uploadUrl が URL でない" }]);
        }
        // 暗号文とはいえ平文の http には送らない
        if (u.protocol !== "https:") throw new SetlogSchemaError(endpoint, [{ message: "uploadUrl が https でない" }]);
        return { uploadUrl, region: parsed.data.region, key: parsed.data.key };
      },
    );
  }

  /**
   * 暗号文を発行された URL に PUT する（dt2）。署名付き URL なので setlog のトークンと x-api-key は送らない。
   * 大きいので直列キューには載せず、タイムアウトも長めにする。
   */
  async uploadMedia(uploadUrl: string, cipher: Buffer, opts: { timeoutMs?: number } = {}): Promise<void> {
    if (new URL(uploadUrl).protocol !== "https:") throw new Error("uploadUrl が https でない");
    const res = await this.fetchImpl(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(cipher),
      redirect: "error",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      // 応答本文（S3 のエラー XML）には署名付き URL の断片が入りうるので残さない
      throw new SetlogHttpError(res.status, "PUT <uploadUrl>", "");
    }
    await res.body?.cancel().catch(() => {});
  }

  /**
   * 画像・動画を snap として送る（POST /chat/{conversationId}/message、fn1.a）。**アカウントへの書き込み。**
   * アプリがチャットから写真・動画を送るときと同じ形：type=snap、本文（envelope）は無く、media と mediaCipherV=1 を付ける。
   * contentType・media.mimeType は暗号化に使った MIME と同じにする（AAD に入るので）。
   */
  async sendMediaMessage(params: {
    conversationId: string;
    messageId: string;
    mimeType: SendableMediaType;
    keys: MessageKeyEntry[];
    media: { path: string; region: string; width?: number; height?: number };
    parentId?: string;
  }): Promise<string> {
    const { width, height } = params.media;
    const body = {
      type: "snap",
      conversationId: params.conversationId,
      messageId: params.messageId,
      uuid: crypto.randomUUID(),
      refreshesStaleKeys: true,
      ...(params.parentId?.trim() ? { parentId: params.parentId } : {}),
      contentType: params.mimeType,
      keys: params.keys,
      media: {
        path: params.media.path,
        region: params.media.region,
        mimeType: params.mimeType,
        // アプリは幅と高さが両方とも正のときだけ入れる
        ...(width && height && width > 0 && height > 0 ? { dimensions: { width, height } } : {}),
        permission: "allow_saving",
      },
      mediaCipherV: 1,
    };
    const r = await this.request(
      `/chat/${params.conversationId}/message`,
      SendMessageResponseSchema,
      { method: "POST", body: JSON.stringify(body) },
    );
    return r.messageId;
  }

  // --- リアクション -----------------------------------------------------

  /**
   * メッセージにリアクションを付ける（POST /chat/message/addReaction、q74.d）。**友達に見える書き込み。**
   * text は絵文字そのもの（暗号化しない）。id はリアクションごとの UUID。factor・scale はアプリの既定値（1）。
   * 応答の形は分かっていないので、2xx なら本文を読まずに成功とする。
   */
  async addReaction(params: { conversationId: string; messageId: string; text: string }): Promise<void> {
    const endpoint = "/chat/message/addReaction";
    const body = {
      conversationId: params.conversationId,
      messageId: params.messageId,
      id: crypto.randomUUID(),
      text: params.text,
      factor: 1,
      scale: 1,
    };
    await this.call(`${this.baseUrl}${endpoint}`, endpoint, { method: "POST", body: JSON.stringify(body) }, discardBody);
  }

  /** リアクションを外す（POST /chat/message/removeReaction、q74.H）。どれを外すかは text で決まる。 */
  async removeReaction(params: { conversationId: string; messageId: string; text: string }): Promise<void> {
    const endpoint = "/chat/message/removeReaction";
    const body = { conversationId: params.conversationId, messageId: params.messageId, text: params.text };
    await this.call(`${this.baseUrl}${endpoint}`, endpoint, { method: "POST", body: JSON.stringify(body) }, discardBody);
  }
}

async function discardBody(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => {});
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
