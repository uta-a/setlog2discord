# setlog2discord

setlog の友達の新着（2秒クリップとグループのテキストチャット）を、自分専用の Discord サーバーに流す Bot。Discord からグループチャットへの返信もできる。自宅の Ubuntu Server で常駐させる。非公開リポジトリとして扱い、公開・再配布はしない。

> 当初は Web ビューアとして作っていたが、2026-11-18 に Discord Bot へ方針を変えた。リポジトリ名も 2026-11-21 に `setlog-webapp` から `setlog2discord` に変えた。

- 設計書：[docs/design.md](docs/design.md)
- API 解析メモ：[docs/api.md](docs/api.md)（WebSocket は 4.9 節）
- 静的解析レポート：[docs/static-analysis.md](docs/static-analysis.md)
- 自宅サーバーへの導入：[docs/deploy.md](docs/deploy.md)
- 動的解析ランブック：[docs/dynamic-analysis.md](docs/dynamic-analysis.md)
- フィクスチャと伏せ字ルール：[fixtures/README.md](fixtures/README.md)
- キャプチャツール：[tools/capture/](tools/capture/)

## 現在のフェーズ

フェーズ0（API 解析）は完了。フェーズ1（Bot）は B4（Discord から setlog への送信）まで実装済み。B5（自宅サーバーへの導入）も済み、`rakko-server` で常駐している（[docs/deploy.md](docs/deploy.md)）。

## 起動

1. Discord Developer Portal で Bot アプリを作り、自分のサーバーに招待する（権限：チャンネルを見る・メッセージを送信・ファイルを添付・埋め込みリンク・メッセージ履歴を読む・ウェブフックの管理。最後のものは通知に友達の名前を出すため）。Bot の設定で **MESSAGE CONTENT INTENT** を有効にする（自分の発言を setlog に送るため）
2. `.env.local`（または `.env`）に `DISCORD_TOKEN=...` を書く。setlog の `SETLOG_TOKEN`・`SETLOG_USER_ID`・`SETLOG_X_API_KEY` も同じファイルに置く（`tools/setlog-login.ts` の verify で前の 2 つは書き込まれる）
3. 鍵バックアップ（`.secrets.keybackup.json`、verify で保存される）とパスフレーズ（`.secrets.passphrase`、自分で書く）を置く
4. `bot.config.example.json` を `bot.config.json` にコピーし、guild・自分のユーザー ID・チャンネル ID・setlog の `conversationId` を書く。投稿を流したくない人がいれば、`tools/list-members.ts` でその人の setlog のユーザー ID を調べて `ignoredSenderIds` に書く
5. `pnpm install` → `pnpm start`

起動すると、設定外の guild から退出し、設定したチャンネルを確かめてから `#bot-status` に起動を通知する。

スマホで setlog アプリを開くと、新着が Bot に届かなくなる（setlog は最後に接続した 1 本にだけ送る）。Bot は 5 分ごとにつなぎ直して戻る。すぐ戻したいときは Discord で `/reconnect` を使う（自分だけが使える）。

## ディレクトリ

```
bot/            Discord Bot
lib/setlog/     setlog の API クライアント、スキーマ、変換、E2EE 暗号
docs/           設計書と API 解析メモ
fixtures/       伏せ字済みのレスポンス例（コミットする）
captures/       生のキャプチャ（git 管理外。トークンや実名を含む）
tools/capture/  解析用のキャプチャツール
```

APK、jadx の出力、HAR、鍵バックアップとパスフレーズ（`.secrets.*`）などは `.gitignore` で除外している。
