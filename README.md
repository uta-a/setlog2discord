# setlog-webapp

setlog の友達の新着（2秒クリップとグループのテキストチャット）を、自分専用の Discord サーバーに流す Bot。Discord からグループチャットへの返信もできる。自宅の Ubuntu Server で常駐させる。非公開リポジトリとして扱い、公開・再配布はしない。

> 当初は Web ビューアとして作っていたが、2026-11-18 に Discord Bot へ方針を変えた。リポジトリ名は当面そのまま。

- 設計書：[docs/design.md](docs/design.md)
- API 解析メモ：[docs/api.md](docs/api.md)（WebSocket は 4.9 節）
- 静的解析レポート：[docs/static-analysis.md](docs/static-analysis.md)
- 動的解析ランブック：[docs/dynamic-analysis.md](docs/dynamic-analysis.md)
- フィクスチャと伏せ字ルール：[fixtures/README.md](fixtures/README.md)
- キャプチャツール：[tools/capture/](tools/capture/)

## 現在のフェーズ

フェーズ0（API 解析）は完了。フェーズ1（Bot）の B0（Next.js を外して Bot の骨組みを作る）から始める。

## ディレクトリ

```
bot/            Discord Bot（B0 で追加予定）
lib/setlog/     setlog の API クライアント、スキーマ、変換、E2EE 暗号
docs/           設計書と API 解析メモ
fixtures/       伏せ字済みのレスポンス例（コミットする）
captures/       生のキャプチャ（git 管理外。トークンや実名を含む）
tools/capture/  解析用のキャプチャツール
```

APK、jadx の出力、HAR、鍵バックアップとパスフレーズ（`.secrets.*`）などは `.gitignore` で除外している。
