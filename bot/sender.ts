/**
 * Discord から setlog へのテキスト送信（設計書7.3）。**友達に見える書き込み。**
 *
 * 1. 会話の参加者の公開鍵と kid を取る（getParticipantKeys）。実物は自分を含まなかった（2026-11-19）ので、
 *    自分の kid と公開鍵はプロフィール（getMyKey）から取る。どちらも短時間キャッシュする
 * 2. 自分の kid に合う秘密鍵が手元にあり、その公開鍵が setlog の登録と一致するか確かめる
 *    （端末の再登録で鍵が変わっていたら、古い鍵で送ると友達が読めないので送らない）
 * 3. encryptText で参加者と自分（重ねない）宛に暗号化し、sendTextMessage で送る。返信なら parentId を付ける
 *
 * 送れなかった理由は SendError の message に入れる（Discord の返信にそのまま出す。本文や鍵は入れない）。
 * 本文はログに出さない。
 */
import { createPublicKey, randomUUID } from "node:crypto";
import { SetlogAuthError } from "../lib/setlog/client";
import { encryptText, rawOfPublicKey, type Envelope, type MessageKeyEntry } from "../lib/setlog/crypto";
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
  /** 参加者の鍵をキャッシュする時間。既定 60 秒。 */
  keysTtlMs?: number;
  now?: () => number;
};

export type Sender = {
  /** parentId を渡すと、その setlog のメッセージへの返信として送る。 */
  send(conversationId: string, text: string, opts?: { parentId?: string }): Promise<{ messageId: string }>;
};

/** 1 回に送れる長さ（Discord の発言は 2000 文字までなので、普通は超えない）。 */
export const MAX_TEXT = 2000;

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

  return {
    async send(conversationId, text, opts = {}) {
      const body = text.trim();
      if (!body) throw new SendError("empty messages cannot be sent");
      if ([...body].length > MAX_TEXT) throw new SendError(`too long (max ${MAX_TEXT} characters)`);

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
      const recipients = [...others, me].map((k) => ({ uid: k.userId, kid: k.kid, publicKeyB64: k.publicKey }));
      const messageId = randomUUID();
      const { envelope, keys: wrapped } = encryptText({
        text: body,
        convId: conversationId,
        msgId: messageId,
        senderId: deps.myUserId,
        myPriv,
        sender: { kid: me.kid, publicKeyB64: me.publicKey },
        recipients,
      });
      let sentId: string;
      try {
        sentId = await deps.sendTextMessage({ conversationId, messageId, envelope, keys: wrapped, parentId: opts.parentId });
      } catch (e) {
        // 鍵が古かった可能性があるので、次は取り直す
        cache.delete(conversationId);
        myKeyCache = null;
        if (e instanceof SetlogAuthError) throw new SendError("setlog token has expired");
        log.warn(`setlog への送信に失敗: ${e instanceof Error ? e.message : String(e)}`);
        throw new SendError("failed to send to setlog");
      }
      // 自分宛も入れている（自分のアプリで履歴を開けるように。アプリも自分を含めて送っている）
      const reply = opts.parentId ? `、返信先 ${opts.parentId.slice(0, 8)}` : "";
      log.info(`setlog に送信（msg=${sentId.slice(0, 8)}、宛先は友達 ${others.length} 人と自分${reply}）`);
      return { messageId: sentId };
    },
  };
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
