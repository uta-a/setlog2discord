/**
 * E2EE の鍵の束（設計書5章）。起動時に鍵バックアップとパスフレーズから秘密鍵を復元し、kid ごとにメモリに持つ。
 *
 * - 鍵バックアップ：BOT_KEY_BACKUPS（カンマ区切り。既定 .secrets.keybackup.json）。
 *   端末の再登録で鍵が変わったら、古いバックアップを別名で残して並べれば旧鍵のクリップも開ける
 * - パスフレーズ：BOT_PASSPHRASE_FILE（既定 .secrets.passphrase）。全バックアップで共通
 *
 * エラーにはファイルの場所と項目名だけを出し、パスフレーズや鍵の中身は出さない。
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { recoverPrivateKeyFromBackup } from "../lib/setlog/crypto";
import type { Keyring } from "../lib/setlog/media";

export class KeyringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyringError";
  }
}

const BackupFileSchema = z.object({
  backup: z.object({
    v: z.number(),
    alg: z.string(),
    kdf: z.object({ name: z.string(), iterations: z.number().int().positive(), saltB64: z.string() }),
    aadB64: z.string(),
    ctB64: z.string(),
    kid: z.string().min(1),
    publicKeyB64: z.string(),
  }),
});

function readText(path: string, what: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    throw new KeyringError(`${what}が読めない: ${path}`);
  }
}

export function loadKeyring(env: Record<string, string | undefined>): Keyring {
  const backupPaths = (env.BOT_KEY_BACKUPS ?? ".secrets.keybackup.json")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (backupPaths.length === 0) throw new KeyringError("BOT_KEY_BACKUPS が空");
  const passPath = env.BOT_PASSPHRASE_FILE ?? ".secrets.passphrase";
  const passphrase = readText(passPath, "パスフレーズのファイル").trim();
  if (!passphrase) throw new KeyringError(`パスフレーズのファイルが空: ${passPath}`);

  const keyring = new Map<string, ReturnType<typeof recoverPrivateKeyFromBackup>["privateKey"]>();
  for (const path of backupPaths) {
    let json: unknown;
    try {
      json = JSON.parse(readText(path, "鍵バックアップ"));
    } catch (e) {
      if (e instanceof KeyringError) throw e;
      throw new KeyringError(`鍵バックアップが JSON として読めない: ${path}`);
    }
    const parsed = BackupFileSchema.safeParse(json);
    if (!parsed.success) {
      const keys = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
      throw new KeyringError(`鍵バックアップの形が違う（${keys}）: ${path}`);
    }
    try {
      const { privateKey, kid } = recoverPrivateKeyFromBackup(parsed.data.backup, passphrase);
      keyring.set(kid, privateKey);
    } catch {
      throw new KeyringError(`鍵を復元できない（パスフレーズ違いの可能性）: ${path}`);
    }
  }
  return keyring;
}
