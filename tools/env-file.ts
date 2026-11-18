/**
 * env ファイル（KEY=VALUE の行）の指定キーだけを置き換える。無いキーは末尾に足す。
 * コメント行や他のキーには触らない。tools/setlog-login.ts から使う。
 */
export function upsertEnv(text: string, values: Record<string, string>): string {
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error(`env のキー名が不正: ${key}`);
    if (/[\r\n]/.test(value)) throw new Error(`env の値に改行を含められない: ${key}`);
  }
  const lines = text.length ? text.replace(/\r?\n$/, "").split(/\r?\n/) : [];
  for (const [key, value] of Object.entries(values)) {
    const i = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (i >= 0) lines[i] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  return lines.join("\n") + "\n";
}
