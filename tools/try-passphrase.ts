/**
 * 自分の鍵バックアップを、思い出せないパスフレーズの候補で開けるか試す（設計書5章）。
 *
 * 候補は 1 行 1 つのファイルに書く（既定: .secrets.passphrase-candidates）。空行と
 * # で始まる行は飛ばす。各候補の前後の空白は落として試す。
 *
 * 使い方（リポジトリルートで）:
 *   pnpm exec tsx tools/try-passphrase.ts [候補ファイル] [鍵バックアップ]
 *   既定の鍵バックアップは .secrets.keybackup.json
 *
 * 当たった候補は .secrets.passphrase に保存する（権限 600）。パスフレーズそのものは
 * 画面に出さない（何行目が当たったかだけ出す）。
 */
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { recoverPrivateKeyFromBackup, type KeyBackup } from "../lib/setlog/crypto";

const candFile = process.argv[2] ?? ".secrets.passphrase-candidates";
const backupFile = process.argv[3] ?? ".secrets.keybackup.json";
const OUT = ".secrets.passphrase";

if (!existsSync(candFile)) {
  console.error(`候補ファイルが無い: ${candFile}（1 行に 1 つパスフレーズを書く）`);
  process.exit(1);
}
const backupJson = JSON.parse(readFileSync(backupFile, "utf-8")) as { backup?: KeyBackup } & KeyBackup;
const backup = backupJson.backup ?? backupJson;

const candidates = readFileSync(candFile, "utf-8")
  .split(/\r?\n/)
  .map((line, i) => ({ line: i + 1, value: line.trim() }))
  .filter((c) => c.value.length > 0 && !c.value.startsWith("#"));

if (candidates.length === 0) {
  console.error("候補が 0 件（空行と # 行は飛ばす）");
  process.exit(1);
}

console.log(`${candidates.length} 件の候補を試す（kid=${String(backup.kid).slice(0, 8)}）`);
let hit: number | null = null;
for (const c of candidates) {
  try {
    recoverPrivateKeyFromBackup(backup, c.value);
    hit = c.line;
    break;
  } catch {
    // 不一致。次へ
  }
}

if (hit === null) {
  console.log("どれも一致しなかった");
  process.exit(2);
}

const value = candidates.find((c) => c.line === hit)!.value;
const tmp = `${OUT}.tmp-${process.pid}`;
writeFileSync(tmp, value, { mode: 0o600 });
renameSync(tmp, OUT);
chmodSync(OUT, 0o600);
console.log(`${hit} 行目の候補が一致。${OUT} に保存した（権限 600）`);
