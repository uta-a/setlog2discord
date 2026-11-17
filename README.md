# setlog-webapp

setlog のログを PC やタブレットのブラウザで見返す、自分専用の Web ビューア。非公開リポジトリとして扱い、公開・再配布はしない。

- 設計書：[docs/design.md](docs/design.md)
- API 解析メモ：[docs/api.md](docs/api.md)
- 静的解析レポート：[docs/static-analysis.md](docs/static-analysis.md)
- 動的解析ランブック：[docs/dynamic-analysis.md](docs/dynamic-analysis.md)
- フィクスチャと伏せ字ルール：[fixtures/README.md](fixtures/README.md)
- キャプチャツール：[tools/capture/](tools/capture/)

## 現在のフェーズ

フェーズ0（API 解析）。静的解析（jadx）は完了。次は[動的解析ランブック](docs/dynamic-analysis.md)に沿って実通信をキャプチャし、`docs/api.md` の「状態＝静的」を実測で確定させる。6 操作分の仕様が揃い、方式 A / A′ / C が確定するまで UI には手をつけない。

## ディレクトリ

```
docs/        設計書と API 解析メモ
fixtures/    伏せ字済みのレスポンス例（コミットする）
captures/    生のキャプチャ（git 管理外。トークンや実名を含む）
```

APK、jadx の出力、HAR などの生データは `.gitignore` で除外している。
