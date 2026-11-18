import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { appBackoffMs, startSetlogSocket, type SetlogSocket, type SocketHandlers } from "./setlog-socket";

type Recorder = SocketHandlers & { events: string[]; frames: string[] };

function recorder(): Recorder {
  const r: Recorder = {
    events: [],
    frames: [],
    onOpen: () => r.events.push("open"),
    onFrame: (t) => r.frames.push(t),
    onFatal: (why) => r.events.push(`fatal:${why}`),
    onDownTooLong: () => r.events.push("down"),
    onRecovered: () => r.events.push("recovered"),
  };
  return r;
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("待ちきれなかった");
    await new Promise((r) => setTimeout(r, 10));
  }
}

let cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

/** テスト用の setlog WebSocket サーバー。onUpgrade で 401 などを返せる。 */
async function server(opts: { status?: () => number | null; onConnection?: (s: ServerSocket) => void } = {}) {
  const http: Server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const tokens: (string | undefined)[] = [];
  http.on("upgrade", (req, socket, head) => {
    tokens.push(req.headers["jwt-key"] as string | undefined);
    const status = opts.status?.() ?? null;
    if (status) {
      socket.end(`HTTP/1.1 ${status} Nope\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => opts.onConnection?.(ws));
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}/`;
  cleanups.push(
    () =>
      new Promise<void>((r) => {
        for (const c of wss.clients) c.terminate();
        wss.close();
        http.closeAllConnections();
        http.close(() => r());
      }),
  );
  return { url, tokens };
}

function start(url: string, h: SocketHandlers, extra: Partial<Parameters<typeof startSetlogSocket>[0]> = {}): SetlogSocket {
  const s = startSetlogSocket({ token: "tok", url, checkIntervalMs: 20, backoffMs: () => 30, ...extra }, h);
  cleanups.push(() => s.stop());
  return s;
}

describe("appBackoffMs", () => {
  it("1, 2, 4, … 32 秒で頭打ち", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(appBackoffMs)).toEqual([
      1000, 2000, 4000, 8000, 16000, 32000, 32000, 32000,
    ]);
  });
});

describe("startSetlogSocket", () => {
  it("jwt-key を付けて接続し、フレームを渡す", async () => {
    const { url, tokens } = await server({ onConnection: (s) => s.send('{"action":"typing"}') });
    const r = recorder();
    start(url, r);
    await until(() => r.frames.length === 1);
    expect(tokens).toEqual(["tok"]);
    expect(r.events).toEqual(["open"]);
    expect(r.frames[0]).toBe('{"action":"typing"}');
  });

  it("切られたら張り直し、そのたびに onOpen を呼ぶ", async () => {
    let n = 0;
    const { url } = await server({ onConnection: (s) => (++n === 1 ? s.close(1001) : undefined) });
    const r = recorder();
    start(url, r);
    await until(() => r.events.filter((e) => e === "open").length === 2);
  });

  it("接続時の 401 は再接続せず fatal:auth", async () => {
    const { url, tokens } = await server({ status: () => 401 });
    const r = recorder();
    start(url, r);
    await until(() => r.events.includes("fatal:auth"));
    await new Promise((res) => setTimeout(res, 150));
    expect(tokens.length).toBe(1);
    expect(r.events).toEqual(["fatal:auth"]);
  });

  it("401 以外の HTTP エラーは再接続する", async () => {
    let n = 0;
    const { url } = await server({ status: () => (++n === 1 ? 503 : null) });
    const r = recorder();
    start(url, r);
    await until(() => r.events.includes("open"));
  });

  it("close 4403 は再接続せず fatal:locked", async () => {
    let conns = 0;
    const { url } = await server({
      onConnection: (s) => {
        conns++;
        s.close(4403);
      },
    });
    const r = recorder();
    start(url, r);
    await until(() => r.events.includes("fatal:locked"));
    await new Promise((res) => setTimeout(res, 150));
    expect(conns).toBe(1);
  });

  it("ping が途絶えたら切って張り直す", async () => {
    let conns = 0;
    const { url } = await server({ onConnection: () => conns++ });
    const r = recorder();
    start(url, r, { pingTimeoutMs: 100 });
    await until(() => conns >= 2);
  });

  it("ping が来ていれば切らない", async () => {
    let conns = 0;
    const { url } = await server({
      onConnection: (s) => {
        conns++;
        const t = setInterval(() => s.ping(), 30);
        s.on("close", () => clearInterval(t));
      },
    });
    const r = recorder();
    start(url, r, { pingTimeoutMs: 100 });
    await new Promise((res) => setTimeout(res, 400));
    expect(conns).toBe(1);
  });

  it("つないですぐ切られる間はバックオフの回数が増え続ける", async () => {
    const waits: number[] = [];
    const { url } = await server({ onConnection: (s) => s.close(1011) });
    const r = recorder();
    start(url, r, {
      minStableMs: 10_000,
      backoffMs: (n) => {
        waits.push(n);
        return 10;
      },
    });
    await until(() => waits.length >= 3);
    expect(waits.slice(0, 3)).toEqual([1, 2, 3]);
  });

  it("切れたまま downNotifyMs たったら通知し、つながったら復旧を通知する", async () => {
    let allow = false;
    const { url } = await server({ status: () => (allow ? null : 503) });
    const r = recorder();
    start(url, r, { downNotifyMs: 80 });
    await until(() => r.events.includes("down"));
    allow = true;
    await until(() => r.events.includes("recovered"));
    expect(r.events).toEqual(["down", "recovered", "open"]);
  });

  it("ハンドシェイクの応答が無ければあきらめて張り直す", async () => {
    let upgrades = 0;
    const held: import("node:stream").Duplex[] = [];
    const http: Server = createServer();
    http.on("upgrade", (_req, socket) => {
      upgrades++;
      held.push(socket); // 応答しない
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    cleanups.push(
      () =>
        new Promise<void>((r) => {
          for (const s of held) s.destroy();
          http.close(() => r());
        }),
    );
    const url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}/`;
    start(url, recorder(), { handshakeTimeoutMs: 100 });
    await until(() => upgrades >= 2);
  });

  it("recycleMs ごとにこちらから閉じてすぐつなぎ直し、そのたびに onOpen を呼ぶ（バックオフしない）", async () => {
    const closes: number[] = [];
    let conns = 0;
    const { url } = await server({
      onConnection: (s) => {
        conns++;
        s.on("close", (code) => closes.push(code));
      },
    });
    const r = recorder();
    let backoffCalls = 0;
    start(url, r, {
      recycleMs: 60,
      backoffMs: () => {
        backoffCalls++;
        return 5000;
      },
    });
    await until(() => r.events.filter((e) => e === "open").length >= 3);
    expect(closes.slice(0, 2)).toEqual([1000, 1000]);
    expect(backoffCalls).toBe(0);
    expect(r.events.filter((e) => e !== "open")).toEqual([]);
    expect(conns).toBeGreaterThanOrEqual(3);
  });

  it("reconnectNow ですぐつなぎ直し、onOpen を呼ぶ（バックオフしない）", async () => {
    let conns = 0;
    const { url } = await server({ onConnection: () => conns++ });
    const r = recorder();
    const s = start(url, r, { recycleMs: 0, backoffMs: () => 5000 });
    await until(() => conns === 1 && r.events.includes("open"));
    expect(s.reconnectNow()).toBe(true);
    await until(() => r.events.filter((e) => e === "open").length === 2);
    expect(conns).toBe(2);
  });

  it("つながっていないときの reconnectNow は何もしない（false）", async () => {
    const { url } = await server({ status: () => 503 });
    const r = recorder();
    const s = start(url, r, { backoffMs: () => 5000 });
    await new Promise((res) => setTimeout(res, 50));
    expect(s.reconnectNow()).toBe(false);
  });

  it("stop したら再接続しない", async () => {
    let conns = 0;
    const { url } = await server({ onConnection: () => conns++ });
    const r = recorder();
    const s = start(url, r);
    await until(() => conns === 1);
    s.stop();
    await new Promise((res) => setTimeout(res, 150));
    expect(conns).toBe(1);
  });
});
