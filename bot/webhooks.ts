/**
 * 友達の名前で投稿するための Webhook（2026-11-19 に追加）。
 *
 * Discord の通知には投稿者の名前が出る。Bot のまま投稿すると「setlog」としか出ず誰の投稿か分からないので、
 * 投稿先のチャンネルごとに Bot が作った Webhook を 1 つ持ち、username を友達の名前にして投稿する。
 *
 * - Webhook は Bot（アプリ）が作ったもの（applicationId が Bot）だけを使う。無ければ作る（Manage Webhooks の権限が要る）
 * - 権限が無いなど Webhook を使えないチャンネルでは、これまでどおり Bot として投稿する（呼び出し側）
 * - Webhook は Discord の返信を作れないので、返信は返信先へのリンクの 1 行で示す（replyLine）
 * - Webhook の URL（トークン）はログに出さない
 */
import { ChannelType, type Client, type Webhook } from "discord.js";
import { FALLBACK_NAME } from "./posting";
import { log } from "./log";

const HOOK_NAME = "setlog";
const USERNAME_MAX = 80;

/** Webhook の username にする。Discord が使わせない語（discord・clyde）は間にゼロ幅の文字を入れて崩す。 */
export function webhookUsername(name: string): string {
  const base = name.trim() || FALLBACK_NAME;
  const safe = base.replace(/discord/gi, (w) => `${w[0]}​${w.slice(1)}`).replace(/clyde/gi, (w) => `${w[0]}​${w.slice(1)}`);
  return [...safe].slice(0, USERNAME_MAX).join("");
}

/** 返信先のメッセージへのリンクの 1 行（小さい字）。 */
export function replyLine(guildId: string, channelId: string, messageId: string): string {
  return `-# 返信: https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

/** Webhook のうち、ここで使う操作だけ（discord.js の Webhook をそのまま渡せる）。 */
export type HookLike = { id: string; name: string; edit(opts: { avatar: Buffer }): Promise<unknown> };

/** チャンネルの Webhook の操作。list は Bot（アプリ）が作り、トークンを持っているものだけを返す。 */
export type ChannelHooks<H extends HookLike = HookLike> = {
  list(): Promise<H[]>;
  create(name: string, avatar?: Buffer): Promise<H>;
};

/** 友達ごとの Webhook の名前（チャンネルの設定にだけ出る。投稿の名前は username で毎回付ける）。 */
export function hookNameFor(userId: string): string {
  return `${HOOK_NAME} ${userId}`.slice(0, USERNAME_MAX);
}

export type WebhookDirectory<H extends HookLike = HookLike> = {
  /**
   * 投稿に使う Webhook。アイコンがある人は、その人の Webhook（アイコン付き）を探すか作る。
   * アイコンが無い人と、Webhook の数の上限に達したときは共用の Webhook。使えなければ null。
   */
  get(channelId: string, sender: { userId: string; avatar?: Buffer }): Promise<H | null>;
  /** Webhook が消されていたときに呼ぶ（次は探し直す）。 */
  forget(channelId: string): void;
};

const sameBytes = (a: Buffer | undefined, b: Buffer) => a !== undefined && a.equals(b);

/**
 * チャンネルごとの Webhook を探すか作り、覚えておく。
 * Webhook のアイコンは「Webhook の設定」に画像を入れて付ける（setlog のアイコンは CDN で image/heic として配信され、
 * 中身が HEIC の人もいて Discord が URL から読めないため。avatar_url は使わない）。
 * 起動前からある Webhook のアイコンが今のものか分からないので、起動後に初めて使うときに 1 回設定し直す。
 * 同じチャンネルの操作は 1 本ずつ行う（同じ人の Webhook を二重に作らないため）。
 */
export function createWebhookDirectory<H extends HookLike>(
  channelOf: (channelId: string) => Promise<ChannelHooks<H>>,
  onUnavailable: (channelId: string, reason: string) => void,
): WebhookDirectory<H> {
  type State = { channel: ChannelHooks<H>; byName: Map<string, H>; applied: Map<string, Buffer> };
  const states = new Map<string, Promise<State>>();
  const locks = new Map<string, Promise<unknown>>();
  const reported = new Set<string>();
  const full = new Set<string>();

  function stateOf(channelId: string): Promise<State> {
    const hit = states.get(channelId);
    if (hit) return hit;
    {
      const p: Promise<State> = (async () => {
        const channel = await channelOf(channelId);
        const hooks = await channel.list();
        return { channel, byName: new Map(hooks.map((h): [string, H] => [h.name, h])), applied: new Map() };
      })();
      states.set(channelId, p);
      // 権限を足したら使えるよう、失敗は覚えない
      p.catch(() => states.delete(channelId));
      return p;
    }
  }

  async function shared(st: State): Promise<H> {
    const hit = st.byName.get(HOOK_NAME);
    if (hit) return hit;
    const created = await st.channel.create(HOOK_NAME);
    st.byName.set(HOOK_NAME, created);
    log.info("共用の Webhook を作成");
    return created;
  }

  async function resolve(channelId: string, sender: { userId: string; avatar?: Buffer }): Promise<H> {
    const st = await stateOf(channelId);
    if (!sender.avatar || full.has(channelId)) return shared(st);
    const name = hookNameFor(sender.userId);
    const hit = st.byName.get(name);
    if (hit) {
      if (!sameBytes(st.applied.get(name), sender.avatar)) {
        try {
          await hit.edit({ avatar: sender.avatar });
          st.applied.set(name, sender.avatar);
        } catch (e) {
          // アイコンを変えられなくても投稿は続ける（前のアイコンのまま）
          log.warn(`Webhook のアイコンを更新できない: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return hit;
    }
    try {
      const created = await st.channel.create(name, sender.avatar);
      st.byName.set(name, created);
      st.applied.set(name, sender.avatar);
      log.info("友達の Webhook を作成");
      return created;
    } catch (e) {
      if ((e as { code?: unknown }).code === 30007) {
        // 1 チャンネルの Webhook の上限（15 個）に達した。以後このチャンネルは共用の Webhook を使う
        log.warn(`Webhook の数が上限に達した（チャンネル ${channelId}）。共用の Webhook を使う`);
        full.add(channelId);
      } else {
        // アイコンの画像を受け付けられなかったなど。今回は共用の Webhook で投稿する（権限が無ければ共用も作れず null になる）
        log.warn(`友達の Webhook を作れない: ${e instanceof Error ? e.message : String(e)}`);
      }
      return shared(st);
    }
  }

  return {
    async get(channelId, sender) {
      const prev = locks.get(channelId) ?? Promise.resolve();
      const run = prev.then(() => resolve(channelId, sender));
      locks.set(channelId, run.catch(() => {}));
      try {
        return await run;
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        log.warn(`Webhook を使えない（チャンネル ${channelId}）: ${reason}`);
        if (!reported.has(channelId)) {
          reported.add(channelId);
          onUnavailable(channelId, reason);
        }
        return null;
      }
    },
    forget(channelId) {
      states.delete(channelId);
    },
  };
}

/** discord.js のチャンネルを ChannelHooks にする。Bot（アプリ）が作り、トークンを持つ Webhook だけを扱う。 */
export function discordChannelHooks(client: Client, channelId: string): Promise<ChannelHooks<Webhook>> {
  return (async () => {
    const ch = await client.channels.fetch(channelId);
    if (!ch || ch.type !== ChannelType.GuildText) throw new Error("not a text channel");
    return {
      async list() {
        const hooks = await ch.fetchWebhooks();
        return [...hooks.values()].filter((h) => h.applicationId === client.user?.id && h.token) as Webhook[];
      },
      create: (name: string, avatar?: Buffer) =>
        ch.createWebhook({ name, avatar: avatar ?? null, reason: "setlog bot: post with the friend's name and icon" }) as Promise<Webhook>,
    };
  })();
}
