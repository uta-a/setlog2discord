/**
 * Discord から setlog への送信（設計書7.3・7.4）。**友達に見える書き込み。**
 *
 * 1. 会話の参加者の公開鍵と kid を取る（getParticipantKeys）。実物は自分を含まなかった（2026-11-19）ので、
 *    自分の kid と公開鍵はプロフィール（getMyKey）から取る。どちらも短時間キャッシュする
 * 2. 自分の kid に合う秘密鍵が手元にあり、その公開鍵が setlog の登録と一致するか確かめる
 *    （端末の再登録で鍵が変わっていたら、古い鍵で送ると友達が読めないので送らない）
 * 3. テキストは encryptText で参加者と自分（重ねない）宛に暗号化し、sendTextMessage で送る。
 *    画像・動画は encryptMedia で暗号化して発行された URL に置き、sendMediaMessage で snap として送る。返信なら parentId を付ける
 *
 * 送れなかった理由は SendError の message に入れる（Discord の返信にそのまま出す。本文や鍵は入れない）。
 * 本文はログに出さない。メッセージの送信は自動で送り直さない（応答が失われただけなら友達の画面で二重になるため）。
 */
import { createPublicKey, randomUUID, type KeyObject } from "node:crypto";
import { SENDABLE_MEDIA_TYPES, SetlogAuthError, type SendableMediaType } from "../lib/setlog/client";
import { encryptMedia, encryptText, rawOfPublicKey, type Envelope, type MessageKeyEntry } from "../lib/setlog/crypto";
import type { Keyring } from "../lib/setlog/media";
import type { ParticipantKey } from "../lib/setlog/schema";
import { log } from "./log";

export class SendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SendError";
  }
}

export type SenderDeps = {
  keyring: Keyring;
  myUserId: string;
  getParticipantKeys: (conversationId: string) => Promise<ParticipantKey[]>;
  /** setlog に登録された自分の kid と公開鍵（GET user/profile）。 */
  getMyKey: () => Promise<{ kid: string | null; publicKey: string }>;
  sendTextMessage: (p: {
    conversationId: string;
    messageId: string;
    envelope: Envelope;
    keys: MessageKeyEntry[];
    parentId?: string;
  }) => Promise<string>;
  getUploadUrl: () => Promise<{ uploadUrl: string; region: string; key: string }>;
  uploadMedia: (uploadUrl: string, cipher: Buffer) => Promise<void>;
  sendMediaMessage: (p: {
    conversationId: string;
    messageId: string;
    mimeType: SendableMediaType;
    keys: MessageKeyEntry[];
    media: { path: string; region: string; width?: number; height?: number };
    parentId?: string;
  }) => Promise<string>;
  /** 参加者の鍵をキャッシュする時間。既定 60 秒。 */
  keysTtlMs?: number;
  now?: () => number;
};

/** 送る画像・動画。width・height は分かれば入れる（Discord の添付が持っている）。 */
export type OutgoingMedia = { data: Buffer; mimeType: string; width?: number | null; height?: number | null };

export type Sender = {
  /** parentId を渡すと、その setlog のメッセージへの返信として送る。 */
  send(conversationId: string, text: string, opts?: { parentId?: string }): Promise<{ messageId: string }>;
  /** 画像・動画を snap として送る。parentId は send と同じ。 */
  sendMedia(conversationId: string, media: OutgoingMedia, opts?: { parentId?: string }): Promise<{ messageId: string }>;
};

/** 1 回に送れる長さ（Discord の発言は 2000 文字までなので、普通は超えない）。 */
export const MAX_TEXT = 2000;

/** 1 つの画像・動画の上限。setlog 側の上限は分かっていない。クリップ 1 本は約 1.4 MB なので十分に大きくとる。 */
export const MAX_MEDIA_BYTES = 50 * 1024 * 1024;

/** 送れる形式か。 */
export function isSendableMediaType(mime: string | null | undefined): mime is SendableMediaType {
  return !!mime && (SENDABLE_MEDIA_TYPES as readonly string[]).includes(mime.toLowerCase());
}

/** 送れない形式・大きさなら SendError を投げる（取得する前にも確かめるため、sendMedia と分けている）。 */
export function checkMedia(mimeType: string | null | undefined, size: number): void {
  if (!isSendableMediaType(mimeType)) {
    throw new SendError(`unsupported file type (${mimeType || "unknown"}). JPEG, PNG, WebP, MP4 and MOV can be sent`);
  }
  if (size <= 0) throw new SendError("the file is empty");
  if (size > MAX_MEDIA_BYTES) throw new SendError(`file too large (max ${MAX_MEDIA_BYTES / 1024 / 1024} MB)`);
}

export function createSender(deps: SenderDeps): Sender {
  const ttl = deps.keysTtlMs ?? 60_000;
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { at: number; keys: ParticipantKey[] }>();
  let myKeyCache: { at: number; key: { kid: string | null; publicKey: string } } | null = null;

  async function myKey(): Promise<{ kid: string | null; publicKey: string }> {
    if (myKeyCache && now() - myKeyCache.at < ttl) return myKeyCache.key;
    const key = await deps.getMyKey();
    myKeyCache = { at: now(), key };
    return key;
  }

  async function participants(conversationId: string): Promise<ParticipantKey[]> {
    const hit = cache.get(conversationId);
    if (hit && now() - hit.at < ttl) return hit.keys;
    const keys = await deps.getParticipantKeys(conversationId);
    cache.set(conversationId, { at: now(), keys });
    return keys;
  }

  type Recipients = {
    myPriv: KeyObject;
    me: { kid: string; publicKeyB64: string };
    recipients: { uid: string; kid: string; publicKeyB64: string }[];
    friends: number;
  };

  /** 宛先（友達と自分）と、送るのに使う自分の鍵を決める。送れない状態なら SendError。 */
  async function recipientsOf(conversationId: string): Promise<Recipients> {
    let keys: ParticipantKey[];
    let mine: { kid: string | null; publicKey: string };
    try {
      [keys, mine] = await Promise.all([participants(conversationId), myKey()]);
    } catch (e) {
      if (e instanceof SetlogAuthError) throw new SendError("setlog token has expired");
      throw new SendError("could not fetch participant keys (setlog unreachable)");
    }
    if (!mine.kid || !mine.publicKey) throw new SendError("this account has no key registered on setlog");
    const me = { userId: deps.myUserId, kid: mine.kid, publicKey: mine.publicKey };
    const myPriv = deps.keyring.get(me.kid);
    if (!myPriv) throw new SendError(`the current key (kid=${me.kid.slice(0, 8)}) is not available locally. Fetch the key backup again`);
    const myPub = rawOfPublicKey(createPublicKey(myPriv)).toString("base64");
    if (myPub !== me.publicKey) throw new SendError("the local key does not match the public key registered on setlog");

    const others = keys.filter((k) => k.userId !== deps.myUserId);
    if (others.length === 0) throw new SendError("this group has no other members");
    // 自分宛も入れる（自分のアプリで履歴を開けるように。アプリも自分を含めて送っている）
    const recipients = [...others, me].map((k) => ({ uid: k.userId, kid: k.kid, publicKeyB64: k.publicKey }));
    return { myPriv, me: { kid: me.kid, publicKeyB64: me.publicKey }, recipients, friends: others.length };
  }

  /** setlog への書き込みの失敗を SendError にする。鍵が古かった可能性があるので、次は取り直す。 */
  function sendFailed(conversationId: string, e: unknown, what: string): SendError {
    cache.delete(conversationId);
    myKeyCache = null;
    if (e instanceof SetlogAuthError) return new SendError("setlog token has expired");
    log.warn(`setlog への${what}に失敗: ${e instanceof Error ? e.message : String(e)}`);
    return new SendError(what === "送信" ? "failed to send to setlog" : "failed to upload the file to setlog");
  }

  function sentLog(kind: string, sentId: string, r: Recipients, parentId?: string): void {
    const reply = parentId ? `、返信先 ${parentId.slice(0, 8)}` : "";
    log.info(`setlog に${kind}を送信（msg=${sentId.slice(0, 8)}、宛先は友達 ${r.friends} 人と自分${reply}）`);
  }

  return {
    async send(conversationId, text, opts = {}) {
      const body = text.trim();
      if (!body) throw new SendError("empty messages cannot be sent");
      if ([...body].length > MAX_TEXT) throw new SendError(`too long (max ${MAX_TEXT} characters)`);
      const r = await recipientsOf(conversationId);
      const messageId = randomUUID();
      const { envelope, keys: wrapped } = encryptText({
        text: body,
        convId: conversationId,
        msgId: messageId,
        senderId: deps.myUserId,
        myPriv: r.myPriv,
        sender: r.me,
        recipients: r.recipients,
      });
      let sentId: string;
      try {
        sentId = await deps.sendTextMessage({ conversationId, messageId, envelope, keys: wrapped, parentId: opts.parentId });
      } catch (e) {
        throw sendFailed(conversationId, e, "送信");
      }
      sentLog("テキスト", sentId, r, opts.parentId);
      return { messageId: sentId };
    },

    async sendMedia(conversationId, media, opts = {}) {
      checkMedia(media.mimeType, media.data.length);
      const mimeType = media.mimeType.toLowerCase() as SendableMediaType;
      const r = await recipientsOf(conversationId);
      const messageId = randomUUID();
      const { cipher, keys: wrapped } = encryptMedia({
        bytes: media.data,
        mime: mimeType,
        convId: conversationId,
        msgId: messageId,
        senderId: deps.myUserId,
        myPriv: r.myPriv,
        sender: r.me,
        recipients: r.recipients,
      });
      // 置き場所の発行とアップロードは友達には見えないが、失敗したら送らない
      let place: { uploadUrl: string; region: string; key: string };
      try {
        place = await deps.getUploadUrl();
        await deps.uploadMedia(place.uploadUrl, cipher);
      } catch (e) {
        throw sendFailed(conversationId, e, "アップロード");
      }
      const width = media.width ?? undefined;
      const height = media.height ?? undefined;
      let sentId: string;
      try {
        sentId = await deps.sendMediaMessage({
          conversationId,
          messageId,
          mimeType,
          keys: wrapped,
          media: { path: place.key, region: place.region, width, height },
          parentId: opts.parentId,
        });
      } catch (e) {
        throw sendFailed(conversationId, e, "送信");
      }
      sentLog(mimeType.startsWith("video/") ? "動画" : "画像", sentId, r, opts.parentId);
      return { messageId: sentId };
    },
  };
}

/** Discord の 1 つの発言を分けたもの。添付は取得を遅らせる（送れない形式・大きさなら取得しない）。 */
export type OutgoingPart =
  | { kind: "text"; text: string }
  | {
      kind: "media";
      /** 失敗の理由に出す名前（Discord の添付のファイル名）。 */
      name: string;
      mimeType: string | null;
      size: number;
      width?: number | null;
      height?: number | null;
      load: () => Promise<Buffer>;
    };

/**
 * 発言を分けた順（テキスト、添付 1、添付 2…）に setlog へ送る（設計書7.4）。setlog では 1 つずつ別のメッセージになる。
 * 返信先（parentId）は最初に送れた 1 件にだけ付ける。1 つ送れなくても残りは送り、送れなかったものの理由を返す。
 */
export async function sendParts(
  sender: Sender,
  conversationId: string,
  parts: OutgoingPart[],
  opts: { parentId?: string } = {},
): Promise<{ firstMessageId?: string; sent: number; failures: string[] }> {
  let firstMessageId: string | undefined;
  let sent = 0;
  const failures: string[] = [];
  for (const part of parts) {
    // 前のものが送れなかったときは、次のものを返信にする
    const parentId = firstMessageId === undefined ? opts.parentId : undefined;
    try {
      let r: { messageId: string };
      if (part.kind === "text") {
        r = await sender.send(conversationId, part.text, { parentId });
      } else {
        checkMedia(part.mimeType, part.size);
        const data = await part.load();
        r = await sender.sendMedia(conversationId, { data, mimeType: part.mimeType!, width: part.width, height: part.height }, { parentId });
      }
      firstMessageId ??= r.messageId;
      sent++;
    } catch (e) {
      const reason = e instanceof SendError ? e.message : "unexpected error";
      if (!(e instanceof SendError)) log.error(`送信で想定外のエラー: ${e instanceof Error ? e.message : String(e)}`);
      failures.push(part.kind === "text" ? `text: ${reason}` : `${part.name}: ${reason}`);
    }
  }
  return { firstMessageId, sent, failures };
}

/**
 * Discord で返信した先の発言から、setlog の返信先（parentId）を決める。返信でなければ undefined。
 * 返信先が setlog のメッセージでない（Bot の通知や失敗の返信など）か、別の会話のものなら送らない
 * （黙って普通の発言として送ると、返信になっていないことに気づけないため）。
 */
export function resolveParent(
  lookup: (discordMessageId: string) => { messageId: string; conversationId: string } | undefined,
  replyToDiscordId: string | undefined,
  conversationId: string,
): string | undefined {
  if (!replyToDiscordId) return undefined;
  const parent = lookup(replyToDiscordId);
  if (!parent) throw new SendError("the replied-to message is not a setlog message (send it without replying)");
  if (parent.conversationId !== conversationId) throw new SendError("the replied-to message belongs to another conversation");
  return parent.messageId;
}
