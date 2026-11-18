/**
 * 最小限のロガー。systemd の journal に流す前提で標準出力・標準エラーに書く。
 * トークン・パスフレーズ・メッセージ本文は渡さないこと（設計書9章）。
 */
const stamp = () => new Date().toISOString();

export const log = {
  info: (msg: string) => console.log(`${stamp()} INFO  ${msg}`),
  warn: (msg: string) => console.warn(`${stamp()} WARN  ${msg}`),
  error: (msg: string) => console.error(`${stamp()} ERROR ${msg}`),
};
