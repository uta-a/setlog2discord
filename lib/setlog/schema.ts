/**
 * setlog の生レスポンスを検証する zod スキーマ。
 *
 * フェーズ0 の動的解析（fixtures/）で実測した形に合わせている。重要な点：
 * - メッセージの `media` は配列でなく単一オブジェクト
 * - カレンダーは投稿がある日の整数配列のみ（件数は返らない）
 * - ID・タイムスタンプは文字列と数値が混在する（元の型を保持する）
 *
 * 形が変わったら parse が落ちるので、BFF 側で「API 仕様変更」として検知する。
 * 未知のフィールドは無視する（.passthrough は使わず、必要な分だけ取り出す）。
 */
import { z } from "zod";

// --- 共通 --------------------------------------------------------------

/** 投稿やプロフィールの参加者。avatarUrl は media パス（ホスト省略）か null。 */
export const ParticipantSchema = z.object({
  userId: z.string(),
  name: z.string(),
  lastName: z.string(),
  avatarUrl: z.string().nullable(),
  tintColor: z.string().nullable(),
  language: z.string(),
  timezone: z.string(),
  region: z.string(),
  shouldHideLocalTime: z.boolean().optional(),
  publicKey: z.string(),
  kid: z.string().nullable(),
});
export type Participant = z.infer<typeof ParticipantSchema>;

// --- 2. 認証 -----------------------------------------------------------

/** ログイン/プロフィールの user。token は verify 応答にのみ入る。 */
export const UserSchema = z.object({
  userId: z.string(),
  name: z.string(),
  lastName: z.string(),
  avatarUrl: z.string().nullable(),
  publicKey: z.string(),
  kid: z.string().nullable(),
  region: z.string(),
  language: z.string(),
  timezone: z.string(),
  hasKeyBackup: z.boolean(),
  backupEmailVerified: z.boolean().optional(),
  backupEmailEnabled: z.boolean().optional(),
  pushFrequency: z.number().optional(),
  // token はローテーションしないが、ログイン verify では必ず入る
  token: z.string().optional(),
});
export type User = z.infer<typeof UserSchema>;

export const LoginResponseSchema = z.object({ user: UserSchema });
export const ProfileResponseSchema = z.object({
  success: z.boolean().optional(),
  user: UserSchema,
});

// --- 3. グループ一覧（collections）------------------------------------

export const CollectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(), // "collection"（グループ/ソロ）。DM は別経路なので基本出ない
  roomType: z.string(), // "log" | "vlog" | "stack"
  creatorId: z.string(),
  createdTimestamp: z.string(),
  updatedTimestamp: z.string(),
  maxParticipants: z.number(),
  participants: z.array(ParticipantSchema),
  lastReadTimestamp: z.number(),
  roomLocked: z.boolean(),
  memberProfiles: z.record(z.string(), z.unknown()),
});
export type Collection = z.infer<typeof CollectionSchema>;

export const CollectionsResponseSchema = z.object({
  success: z.boolean(),
  collections: z.array(CollectionSchema),
  lastEvaluatedKey: z.string().nullable(),
});

// --- 4.5 カレンダー ---------------------------------------------------

export const CalendarResponseSchema = z.object({
  success: z.boolean(),
  collectionId: z.string(),
  year: z.number(),
  month: z.number(),
  timeZone: z.string(),
  days: z.array(z.number().int()), // 投稿がある日。件数は返らない
});
export type CalendarResponse = z.infer<typeof CalendarResponseSchema>;

// --- 4.4 / 4.6 メッセージ（日別クリップ）------------------------------

/** E2EE の鍵エントリ。自分宛は uid === 自分の userId。 */
export const MessageKeySchema = z.object({
  alg: z.string(),
  kid: z.string(),
  saltB64: z.string(),
  senderKid: z.string(),
  senderPublicKey: z.string(),
  uid: z.string(),
  v: z.number(),
  wrappedB64: z.string(),
});

/** media は単一オブジェクト（配列ではない）。 */
export const MediaSchema = z.object({
  mimeType: z.string(), // "video/mp4"
  path: z.string(), // media.newchatapi.com の後続パス
  permission: z.string(), // "allow_saving" など
  region: z.string(),
  dimensions: z.object({ width: z.number(), height: z.number() }),
  captureCountryCode: z.string().optional(),
  captureUTCOffsetSeconds: z.number().optional(),
  captions: z
    .array(
      z.object({
        style: z.number(),
        text: z.string(),
        time: z.string(),
        translation: z.string(),
      }),
    )
    .optional(),
});
export type Media = z.infer<typeof MediaSchema>;

export const MessageSchema = z.object({
  messageId: z.string(),
  conversationId: z.string(),
  senderId: z.string(),
  senderName: z.string(),
  contentType: z.string(), // "video/mp4"
  envelope: z.unknown().nullable(),
  keys: z.array(MessageKeySchema),
  media: MediaSchema,
  timestamp: z.number(), // ms。date/hour はここから 04:00 起点で算出
  isDeleted: z.boolean(),
  type: z.string(),
  readBy: z.array(z.string()).optional(),
  savedBy: z.array(z.string()).optional(),
  reactions: z.array(z.unknown()).optional(),
});
export type Message = z.infer<typeof MessageSchema>;

export const MessagesResponseSchema = z.object({
  success: z.boolean(),
  messages: z.array(MessageSchema),
});
export type MessagesResponse = z.infer<typeof MessagesResponseSchema>;
