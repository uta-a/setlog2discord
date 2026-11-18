/**
 * setlog の WebSocket 接続の維持（設計書4章）。
 *
 * - jwt-key ヘッダーを付けて接続し、受け取ったフレームの文字列を onFrame に渡す
 * - サーバーは 30 秒ごとに ping を送る。pingTimeoutMs（既定 90 秒）ping もフレームも来なければ切って張り直す
 * - 再接続はアプリと同じバックオフ（1, 2, 4, … 32 秒で頭打ち）。接続が minStableMs 続いてから切れた場合だけ
 *   回数を戻す（つないですぐ切られる状態で 1 秒ごとに叩き続けないため）
 * - 接続時の HTTP 401（トークン失効）と close code 4403（アカウントロック）は再接続せず onFatal を呼ぶ
 * - 切れたまま downNotifyMs（既定 5 分）たったら onDownTooLong、その後つながったら onRecovered
 *
 * ログにトークンは出さない。
 */
import WebSocket from "ws";
import { CLOSE_ACCOUNT_LOCKED, SETLOG_WS_URL } from "../lib/setlog/realtime";
import { log } from "./log";

export type FatalReason = "auth" | "locked";

export type SocketHandlers = {
  /** 接続できるたびに呼ぶ（REST 補完の合図）。 */
  onOpen(): void;
  onFrame(text: string): void;
  onFatal(reason: FatalReason): void;
  onDownTooLong(): void;
  onRecovered(): void;
};

export type SocketOptions = {
  token: string;
  url?: string;
  pingTimeoutMs?: number;
  checkIntervalMs?: number;
  downNotifyMs?: number;
  minStableMs?: number;
  /** n 回目（1 始まり）の再接続までの待ち時間。 */
  backoffMs?: (n: number) => number;
};

/** アプリと同じ min(60s, 1s << min(n-1, 5))。 */
export const appBackoffMs = (n: number) => Math.min(60_000, 1000 * 2 ** Math.min(Math.max(n, 1) - 1, 5));

export type SetlogSocket = { stop(): void };

export function startSetlogSocket(opts: SocketOptions, h: SocketHandlers): SetlogSocket {
  const url = opts.url ?? SETLOG_WS_URL;
  const pingTimeoutMs = opts.pingTimeoutMs ?? 90_000;
  const downNotifyMs = opts.downNotifyMs ?? 5 * 60_000;
  const minStableMs = opts.minStableMs ?? 30_000;
  const backoffMs = opts.backoffMs ?? appBackoffMs;

  let stopped = false;
  let ws: WebSocket | null = null;
  let failures = 0;
  let openedAt: number | null = null;
  let lastAlive = 0;
  let downSince: number | null = Date.now();
  let notifiedDown = false;
  let reconnectTimer: NodeJS.Timeout | null = null;

  const watchdog = setInterval(() => {
    const now = Date.now();
    if (ws && openedAt !== null && now - lastAlive > pingTimeoutMs) {
      log.warn("setlog WebSocket：ping が途絶えたので張り直す");
      ws.terminate();
    }
    if (downSince !== null && !notifiedDown && now - downSince >= downNotifyMs) {
      notifiedDown = true;
      h.onDownTooLong();
    }
  }, opts.checkIntervalMs ?? 10_000);

  function fatal(reason: FatalReason): void {
    if (stopped) return;
    stop();
    h.onFatal(reason);
  }

  function connect(): void {
    if (stopped) return;
    const socket = new WebSocket(url, { headers: { "jwt-key": opts.token }, perMessageDeflate: false });
    ws = socket;
    let down = false;

    /** 1 本のソケットにつき 1 回だけ、再接続を予約する。 */
    const onDown = (why: string) => {
      if (down) return;
      down = true;
      if (ws === socket) ws = null;
      const stable = openedAt !== null && Date.now() - openedAt >= minStableMs;
      openedAt = null;
      if (stopped) return;
      failures = stable ? 1 : failures + 1;
      downSince ??= Date.now();
      const wait = backoffMs(failures);
      log.warn(`setlog WebSocket：切断（${why}）。${Math.round(wait / 1000)} 秒後に再接続（${failures} 回目）`);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, wait);
    };

    socket.on("unexpected-response", (req, res) => {
      const status = res.statusCode ?? 0;
      res.resume();
      req.destroy();
      if (status === 401) {
        down = true;
        if (ws === socket) ws = null;
        log.error("setlog WebSocket：HTTP 401（トークン失効）");
        fatal("auth");
        return;
      }
      onDown(`HTTP ${status}`);
    });

    socket.on("open", () => {
      openedAt = Date.now();
      lastAlive = openedAt;
      log.info("setlog WebSocket：接続");
      if (notifiedDown) h.onRecovered();
      downSince = null;
      notifiedDown = false;
      h.onOpen();
    });

    socket.on("ping", () => {
      lastAlive = Date.now();
    });

    socket.on("message", (data, isBinary) => {
      lastAlive = Date.now();
      if (isBinary) return;
      h.onFrame(data.toString());
    });

    socket.on("close", (code) => {
      if (code === CLOSE_ACCOUNT_LOCKED) {
        down = true;
        if (ws === socket) ws = null;
        log.error(`setlog WebSocket：close ${code}（アカウントロックの可能性）`);
        fatal("locked");
        return;
      }
      onDown(`close ${code}`);
    });

    socket.on("error", (e) => {
      log.warn(`setlog WebSocket：エラー ${e.message}`);
      onDown("error");
    });
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(watchdog);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    const s = ws;
    ws = null;
    if (s) {
      s.removeAllListeners("close");
      s.on("error", () => {});
      if (s.readyState === WebSocket.OPEN) s.close(1000);
      else s.terminate();
    }
  }

  connect();
  return { stop };
}
