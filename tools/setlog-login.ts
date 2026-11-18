/**
 * setlog にメール OTP でログインし、トークンと鍵バックアップを保存する（設計書5章）。
 * アカウントの切り替えと、トークン失効時の再登録に使う。
 *
 * 使い方（リポジトリルートで。SETLOG_X_API_KEY が .env.local にあること）:
 *   pnpm exec tsx --env-file=.env.local tools/setlog-login.ts start  <email>
 *   pnpm exec tsx --env-file=.env.local tools/setlog-login.ts verify <email> <code>
 *   pnpm exec tsx --env-file=.env.local tools/setlog-login.ts backup   # 鍵バックアップだけ取り直す
 *
 * verify が成功すると:
 *   - .env.local の SETLOG_TOKEN と SETLOG_USER_ID を書き換える（他の行は残す。権限 600）
 *   - 鍵バックアップがあれば .secrets.keybackup.json に保存する（権限 600）
 *   - 参加しているグループの名前と conversationId を表示する
 *
 * backup は今の SETLOG_TOKEN で鍵バックアップだけを取り直す（アプリでパスフレーズを
 * 設定し直したとき用。アプリは端末の今の鍵を包み直すだけなので kid は変わらない）。
 *
 * トークン・鍵バックアップの中身は画面に出さない。パスフレーズは扱わない
 * （.secrets.passphrase には自分で書く）。
 */
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { SETLOG_BASE_URL, SetlogClient } from "../lib/setlog/client";
import { upsertEnv } from "./env-file";

const ENV_FILE = ".env.local";
const BACKUP_FILE = ".secrets.keybackup.json";

/** 書き込み途中で壊れないよう、一時ファイルに書いてから置き換える。 */
function writeSecretFile(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

async function saveKeyBackup(apiKey: string, token: string): Promise<void> {
  const r = await fetch(`${SETLOG_BASE_URL}/auth/key-backup`, {
    headers: { "jwt-key": token, "x-api-key": apiKey, "User-Agent": "okhttp/4.12.0" },
  });
  if (!r.ok) throw new Error(`鍵バックアップの取得に失敗: HTTP ${r.status}`);
  const body = (await r.json()) as { backup?: { kid?: string } };
  const backup = body.backup ?? body;
  writeSecretFile(BACKUP_FILE, JSON.stringify({ backup }, null, 2) + "\n");
  console.log(`  kid=${String((backup as { kid?: string }).kid ?? "-").slice(0, 8)} を ${BACKUP_FILE} に保存`);
}

async function main(): Promise<void> {
  const [cmd, email, code] = process.argv.slice(2);
  const apiKey = process.env.SETLOG_X_API_KEY;
  if (!apiKey) throw new Error("SETLOG_X_API_KEY が未設定（.env.local を --env-file で渡す）");
  if (cmd === "backup") {
    const token = process.env.SETLOG_TOKEN;
    if (!token) throw new Error("SETLOG_TOKEN が未設定（先に verify を実行する）");
    console.log("鍵バックアップを取り直す");
    await saveKeyBackup(apiKey, token);
    return;
  }
  if (!email || (cmd !== "start" && cmd !== "verify") || (cmd === "verify" && !code)) {
    throw new Error("使い方: setlog-login.ts start <email> | verify <email> <code> | backup");
  }

  const anon = new SetlogClient({ apiKey });
  if (cmd === "start") {
    await anon.loginStart(email);
    console.log("確認コードをメールで送った。届いたら verify を実行する");
    return;
  }

  const user = await anon.loginVerify(email, code);
  if (!user.token) throw new Error("verify の応答に token が無い");

  const current = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf-8") : "";
  writeSecretFile(ENV_FILE, upsertEnv(current, { SETLOG_TOKEN: user.token, SETLOG_USER_ID: user.userId }));
  console.log(`ログイン成功: userId=${user.userId.slice(0, 8)}… を ${ENV_FILE} に保存`);

  console.log(`鍵バックアップ: hasKeyBackup=${user.hasKeyBackup}`);
  if (user.hasKeyBackup) await saveKeyBackup(apiKey, user.token);
  else console.log("  無い。アプリの設定で鍵バックアップ（パスフレーズ）を有効にしてから backup を実行する");

  const client = new SetlogClient({ apiKey, token: user.token });
  console.log("参加しているグループ（name | conversationId | roomType）:");
  for (const g of (await client.getCollections()) as { id: string; name: string; roomType: string }[]) {
    console.log(`  ${g.name} | ${g.id} | ${g.roomType}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
