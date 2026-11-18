import { createPublicKey, generateKeyPairSync, pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { aeadSeal, rawOfPublicKey } from "../lib/setlog/crypto";
import { KeyringError, loadKeyring } from "./keys";

/** recoverPrivateKeyFromBackup が開ける形の鍵バックアップを作る（反復回数は小さく）。 */
function makeBackup(passphrase: string, kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const privRaw = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const salt = randomBytes(16);
  const aad = Buffer.from("backup-aad");
  const dk = pbkdf2Sync(passphrase, salt, 10, 32, "sha256");
  const pt = Buffer.from(JSON.stringify({ identityPrivateKeyB64: privRaw.toString("base64") }));
  const ct = aeadSeal(dk, pt, aad, randomBytes(12));
  const pubB64 = rawOfPublicKey(createPublicKey(privateKey)).toString("base64");
  expect(pubB64).toBe(rawOfPublicKey(publicKey).toString("base64"));
  return {
    backup: {
      v: 1,
      alg: "x",
      kdf: { name: "PBKDF2-HMAC-SHA256", iterations: 10, saltB64: salt.toString("base64") },
      aadB64: aad.toString("base64"),
      ctB64: ct.toString("base64"),
      kid,
      publicKeyB64: pubB64,
    },
  };
}

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function files(entries: Record<string, string>) {
  dir = mkdtempSync(join(tmpdir(), "keys-test-"));
  for (const [name, body] of Object.entries(entries)) writeFileSync(join(dir, name), body);
  return (name: string) => join(dir, name);
}

describe("loadKeyring", () => {
  it("複数のバックアップを kid ごとに復元する", () => {
    const p = files({
      pass: "secret-pass\n",
      a: JSON.stringify(makeBackup("secret-pass", "kid-a")),
      b: JSON.stringify(makeBackup("secret-pass", "kid-b")),
    });
    const k = loadKeyring({ BOT_KEY_BACKUPS: `${p("a")}, ${p("b")}`, BOT_PASSPHRASE_FILE: p("pass") });
    expect([...k.keys()]).toEqual(["kid-a", "kid-b"]);
  });

  it("パスフレーズが違えば場所だけを出して失敗し、パスフレーズは出さない", () => {
    const p = files({ pass: "wrong-pass", a: JSON.stringify(makeBackup("secret-pass", "kid-a")) });
    try {
      loadKeyring({ BOT_KEY_BACKUPS: p("a"), BOT_PASSPHRASE_FILE: p("pass") });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(KeyringError);
      expect(String(e)).toMatch(/パスフレーズ違い/);
      expect(String(e)).not.toMatch(/wrong-pass|secret-pass/);
    }
  });

  it("ファイルが無い・空・形が違えば KeyringError", () => {
    const p = files({ pass: "x", empty: "\n", bad: JSON.stringify({ backup: { kid: "k" } }) });
    expect(() => loadKeyring({ BOT_KEY_BACKUPS: p("none"), BOT_PASSPHRASE_FILE: p("pass") })).toThrow(/読めない/);
    expect(() => loadKeyring({ BOT_KEY_BACKUPS: p("bad"), BOT_PASSPHRASE_FILE: p("empty") })).toThrow(/空/);
    expect(() => loadKeyring({ BOT_KEY_BACKUPS: p("bad"), BOT_PASSPHRASE_FILE: p("pass") })).toThrow(/形が違う/);
  });
});

describe("loadKeyring（レビューで直した点）", () => {
  it("同じ kid のバックアップが 2 つあれば失敗する", () => {
    const p = files({ pass: "s", a: JSON.stringify(makeBackup("s", "kid-a")), b: JSON.stringify(makeBackup("s", "kid-a")) });
    expect(() => loadKeyring({ BOT_KEY_BACKUPS: `${p("a")},${p("b")}`, BOT_PASSPHRASE_FILE: p("pass") })).toThrow(/同じ kid/);
  });

  it("パスフレーズは末尾の改行だけを落とし、前後の空白は残す", () => {
    const p = files({ pass: " s p \n", a: JSON.stringify(makeBackup(" s p ", "kid-a")) });
    expect(loadKeyring({ BOT_KEY_BACKUPS: p("a"), BOT_PASSPHRASE_FILE: p("pass") }).size).toBe(1);
  });
});
