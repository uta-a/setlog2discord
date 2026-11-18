/**
 * BFF の共通処理。Route Handlers からだけ使う。
 *
 * - setlog クライアントの組み立て（env から）
 * - setlog のエラーを HTTP レスポンスに変換
 *
 * トークンは当面 env（SETLOG_TOKEN）から読む。フェーズ2 で KV + 暗号化に差し替える。
 * Cloudflare Access の検証（Cf-Access-Jwt-Assertion）はデプロイ時に足す（TODO）。
 */
import {
  SetlogAuthError,
  SetlogClient,
  SetlogHttpError,
  SetlogSchemaError,
} from "@/lib/setlog/client";

export function getClient(): SetlogClient {
  const apiKey = process.env.SETLOG_X_API_KEY;
  if (!apiKey) throw new Error("SETLOG_X_API_KEY が未設定");
  return new SetlogClient({ apiKey, token: process.env.SETLOG_TOKEN });
}

export function selfUserId(): string | undefined {
  return process.env.SETLOG_USER_ID || undefined;
}

/** setlog 例外を JSON レスポンスへ。UI は生の形を知らない。 */
export function toErrorResponse(e: unknown): Response {
  if (e instanceof SetlogAuthError) {
    return Response.json(
      { error: "token_invalid", message: "setlog トークンの再登録が必要" },
      { status: 401 },
    );
  }
  if (e instanceof SetlogSchemaError) {
    return Response.json(
      { error: "schema_changed", message: "setlog の API 仕様が変わった可能性", endpoint: e.endpoint },
      { status: 502 },
    );
  }
  if (e instanceof SetlogHttpError) {
    return Response.json(
      { error: "upstream_error", status: e.status, endpoint: e.endpoint },
      { status: 502 },
    );
  }
  const message = e instanceof Error ? e.message : "unknown";
  return Response.json({ error: "internal", message }, { status: 500 });
}
