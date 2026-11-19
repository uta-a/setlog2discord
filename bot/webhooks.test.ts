import { describe, expect, it } from "vitest";
import { replyLine, webhookUsername } from "./webhooks";

describe("webhookUsername", () => {
  it("友達の名前をそのまま使う", () => {
    expect(webhookUsername("たろう")).toBe("たろう");
  });

  it("Discord が Webhook の名前に使わせない語（discord・clyde）を崩し、80 文字で切る", () => {
    expect(webhookUsername("Discord好き")).not.toMatch(/discord/i);
    expect(webhookUsername("clyde")).not.toMatch(/clyde/i);
    expect([...webhookUsername("あ".repeat(100))].length).toBe(80);
  });

  it("空なら既定の名前", () => {
    expect(webhookUsername("   ")).toBe("メンバー");
  });
});

describe("replyLine", () => {
  it("返信先のメッセージへのリンクを小さい字の 1 行で作る（Webhook は Discord の返信を作れないため）", () => {
    expect(replyLine("1", "2", "3")).toBe("-# 返信: https://discord.com/channels/1/2/3");
  });
});

import { createWebhookDirectory, hookNameFor, type ChannelHooks, type HookLike } from "./webhooks";

function fakeChannel(initial: { name: string; mine?: boolean }[] = [], max = 15) {
  const hooks: (HookLike & { avatars: Buffer[]; mine: boolean })[] = [];
  let n = 0;
  const make = (name: string, mine = true) => {
    const h = {
      id: `h${++n}`,
      name,
      mine,
      avatars: [] as Buffer[],
      async edit(o: { avatar: Buffer }) {
        h.avatars.push(o.avatar);
      },
    };
    hooks.push(h);
    return h;
  };
  for (const i of initial) make(i.name, i.mine ?? true);
  let lists = 0;
  const channel: ChannelHooks<(typeof hooks)[number]> = {
    async list() {
      lists++;
      return hooks.filter((h) => h.mine);
    },
    async create(name, avatar) {
      if (hooks.length >= max) throw Object.assign(new Error("Maximum number of webhooks reached"), { code: 30007 });
      const h = make(name);
      if (avatar) h.avatars.push(avatar);
      return h;
    },
  };
  return { channel, hooks, lists: () => lists };
}

describe("createWebhookDirectory", () => {
  const A = Buffer.from("avatar-a");
  const B = Buffer.from("avatar-b");

  it("友達ごとに Webhook を作り、アイコンを設定する。2 回目は同じものを使う", async () => {
    const f = fakeChannel();
    const dir = createWebhookDirectory(async () => f.channel, () => {});
    const h1 = await dir.get("c1", { userId: "u1", avatar: A });
    const h2 = await dir.get("c1", { userId: "u1", avatar: A });
    expect(h1).toBe(h2);
    expect(h1?.name).toBe(hookNameFor("u1"));
    expect(f.hooks[0].avatars).toEqual([A]);
    expect(f.lists()).toBe(1);
  });

  it("起動前からある友達の Webhook を使い、アイコンは起動後に 1 回設定し直す。変わったらまた設定する", async () => {
    const f = fakeChannel([{ name: hookNameFor("u1") }]);
    const dir = createWebhookDirectory(async () => f.channel, () => {});
    await dir.get("c1", { userId: "u1", avatar: A });
    await dir.get("c1", { userId: "u1", avatar: A });
    await dir.get("c1", { userId: "u1", avatar: B });
    expect(f.hooks.length).toBe(1);
    expect(f.hooks[0].avatars).toEqual([A, B]);
  });

  it("アイコンが無い人は共用の Webhook を使う（アイコンは Bot のまま）", async () => {
    const f = fakeChannel();
    const dir = createWebhookDirectory(async () => f.channel, () => {});
    const h = await dir.get("c1", { userId: "u1" });
    expect(h?.name).toBe("setlog");
  });

  it("Webhook の数の上限に達したら共用の Webhook を使う", async () => {
    const f = fakeChannel([{ name: "setlog" }], 1);
    const dir = createWebhookDirectory(async () => f.channel, () => {});
    const h = await dir.get("c1", { userId: "u1", avatar: A });
    expect(h?.name).toBe("setlog");
  });

  it("Bot が作っていない Webhook は使わない", async () => {
    const f = fakeChannel([{ name: hookNameFor("u1"), mine: false }]);
    const dir = createWebhookDirectory(async () => f.channel, () => {});
    const h = await dir.get("c1", { userId: "u1", avatar: A });
    expect(f.hooks.length).toBe(2);
    expect(h).toBe(f.hooks[1]);
  });

  it("チャンネルの Webhook を読めなければ null を返し、理由は 1 回だけ知らせる", async () => {
    const reasons: string[] = [];
    const dir = createWebhookDirectory(
      async () => {
        throw new Error("Missing Permissions");
      },
      (_c, r) => reasons.push(r),
    );
    expect(await dir.get("c1", { userId: "u1", avatar: A })).toBeNull();
    expect(await dir.get("c1", { userId: "u1", avatar: A })).toBeNull();
    expect(reasons).toEqual(["Missing Permissions"]);
  });
});
