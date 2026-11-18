# 自宅サーバーへの導入（B5）

setlog Discord Bot を自宅の Ubuntu Server（`rakko-server`）で、ユーザー単位の systemd サービスとして動かす。設計は [design.md](design.md) の 10・11 章。2026-11-19 にこの手順で導入した。

| 項目 | 値 |
| --- | --- |
| サーバー | `rakko-server`（Ubuntu 24.04、ユーザー `uta`） |
| 置き場所 | `~/vscode/discord/bot/setlog/`（権限 700） |
| Node.js | `/usr/bin/node` の v26（NodeSource から sudo で導入）、pnpm 11 |
| サービス | `~/.config/systemd/user/setlog-bot.service`（[`deploy/setlog-bot.user.service`](../deploy/setlog-bot.user.service)） |
| ログ | `journalctl --user -u setlog-bot` |

sudo が要るのは Node.js の導入だけ。サービスはログインユーザーのまま動かし、ログアウト中も動くよう linger を有効にしておく（`loginctl show-user $USER -p Linger` が `yes`）。

専用ユーザーと `/opt` で動かすシステム単位の版は [`deploy/setlog-bot.service`](../deploy/setlog-bot.service) にある（今は使っていない）。

コマンドの頭の `[Mac]` は手元の Mac で、`[server]` は `ssh rakko-server` の中で実行する。

## 大事な注意：Bot は 1 か所でしか動かさない

setlog は同じアカウントの「最後に接続した 1 本」にしか新着を送らない（[api.md 4.9](api.md)）。Mac とサーバーで同時に動かすと、10 分ごとに配信先を奪い合う。**サーバーで動かしている間は、Mac で `pnpm start` しない。**

## 1. Node.js 26 と pnpm（sudo）

```sh
[server] node -v                               # v26.x ならこの章は飛ばす
[server] curl -fsSL https://deb.nodesource.com/setup_26.x -o /tmp/nodesource_setup.sh
[server] less /tmp/nodesource_setup.sh        # 中身を確かめてから
[server] sudo bash /tmp/nodesource_setup.sh
[server] sudo apt-get install -y nodejs
[server] sudo npm install -g pnpm@11           # Node 25 から pnpm（corepack）は同梱されない
[server] node -v && pnpm -v
```

## 2. コードを置く

サーバーに GitHub の認証情報を置かずに済むよう、Mac で固めて送る。秘密情報と `data/` は `.gitignore` 済みなので入らない。

```sh
[Mac]    cd ~/Projects/setlog-webapp
[Mac]    git archive --format=tar.gz -o /tmp/setlog-bot.tgz HEAD
[Mac]    scp /tmp/setlog-bot.tgz rakko-server:/tmp/ && rm /tmp/setlog-bot.tgz

[server] install -d -m 700 ~/vscode/discord/bot/setlog
[server] tar -xzf /tmp/setlog-bot.tgz -C ~/vscode/discord/bot/setlog && rm /tmp/setlog-bot.tgz
[server] cd ~/vscode/discord/bot/setlog && pnpm install --frozen-lockfile --prod
```

`--prod` で、テストと型チェックの道具（vitest・typescript）は入れない。`tsx` は本番の依存に入っている。

## 3. 秘密情報を置く

次の 4 つを Mac から送る。**いずれもリポジトリ・チャット・Issue に貼らない。** 置き場所が 700 なので、送ってから 600 にするまでの間もほかのユーザーからは読めない。

| ファイル | 中身 |
| --- | --- |
| `.env.local` | `DISCORD_TOKEN`・`SETLOG_TOKEN`・`SETLOG_USER_ID`・`SETLOG_X_API_KEY` |
| `.secrets.keybackup.json` | setlog の鍵バックアップ |
| `.secrets.passphrase` | 鍵バックアップのパスフレーズ |
| `bot.config.json` | guild・チャンネル・グループの対応 |

```sh
[Mac]    cd ~/Projects/setlog-webapp
[Mac]    scp .env.local .secrets.keybackup.json .secrets.passphrase bot.config.json rakko-server:vscode/discord/bot/setlog/

[server] cd ~/vscode/discord/bot/setlog
[server] chmod 600 .env.local .secrets.keybackup.json .secrets.passphrase bot.config.json
[server] install -d -m 700 data
```

鍵と設定を読めるかは、Discord と setlog につながずに確かめられる。

```sh
[server] ./node_modules/.bin/tsx --env-file=.env.local -e 'import { readFileSync } from "node:fs"; import { loadKeyring } from "./bot/keys"; import { loadConfig } from "./bot/config"; console.log(loadKeyring(process.env).size, loadConfig(process.env, readFileSync("bot.config.json", "utf-8")).groups.length)'
```

## 4. Mac の Bot を止めて、状態ストアを引き継ぐ

Mac で動いている Bot を止める（`pnpm start` のターミナルで Ctrl+C）。`data/` に `state.sqlite` だけが残っていれば止まり切っている（`-wal`・`-shm` があれば書き込み途中）。

```sh
[Mac]    scp data/state.sqlite rakko-server:vscode/discord/bot/setlog/data/
[server] chmod 600 ~/vscode/discord/bot/setlog/data/state.sqlite
```

引き継がなくても、初回は起動より前のメッセージを流さないので大量には流れない。

## 5. サービスとして起動する

```sh
[Mac]    scp deploy/setlog-bot.user.service rakko-server:/tmp/setlog-bot.service
[server] install -d -m 700 ~/.config/systemd/user
[server] install -m 644 /tmp/setlog-bot.service ~/.config/systemd/user/setlog-bot.service && rm /tmp/setlog-bot.service
[server] systemd-analyze --user verify ~/.config/systemd/user/setlog-bot.service
[server] systemctl --user daemon-reload
[server] systemctl --user enable --now setlog-bot
[server] journalctl --user -u setlog-bot -f    # 「準備完了」「setlog WebSocket：接続」が出れば動いている
```

`#bot-status` に「起動しました」が出る。サーバーを再起動しても自動で起動する（`enable` 済み・linger 有効）。

## 6. 更新するとき

```sh
[Mac]    git archive --format=tar.gz -o /tmp/setlog-bot.tgz HEAD
[Mac]    scp /tmp/setlog-bot.tgz rakko-server:/tmp/ && rm /tmp/setlog-bot.tgz

[server] systemctl --user stop setlog-bot
[server] tar -xzf /tmp/setlog-bot.tgz -C ~/vscode/discord/bot/setlog && rm /tmp/setlog-bot.tgz
[server] cd ~/vscode/discord/bot/setlog && pnpm install --frozen-lockfile --prod
[server] cp deploy/setlog-bot.user.service ~/.config/systemd/user/setlog-bot.service && systemctl --user daemon-reload
[server] systemctl --user start setlog-bot
```

`git archive` は秘密情報と `data/` を含まないので、上書きしても消えない。ただし、Mac 側から消したファイルはサーバーに残る。

## 困ったとき

| 症状 | 見るところ・対処 |
| --- | --- |
| 起動してすぐ止まる | `journalctl --user -u setlog-bot -n 50`。設定ファイル・鍵・パスフレーズの誤りは、その項目名が出る。10 分に 5 回落ちると systemd が止めるので、直したら `systemctl --user reset-failed setlog-bot && systemctl --user start setlog-bot` |
| 「Used disallowed intents」で起動しない | Discord Developer Portal で Bot の MESSAGE CONTENT INTENT を有効にする |
| `#bot-status` に「トークンが失効した」 | Mac で `tools/setlog-login.ts` の start・verify をやり直し、新しい `.env.local` と `.secrets.keybackup.json` を 3 の手順で置き直して `systemctl --user restart setlog-bot` |
| 新着が届かない | スマホで setlog アプリを開いていると Bot に届かない。10 分以内に戻るのを待つか、Discord で `/reconnect` |
| Mac でも動かしてしまった | Mac の方を止める。Mac の状態ストアは使わない |
| ログアウトすると止まる | `loginctl enable-linger`（sudo が要る場合あり） |

止めるとき：`systemctl --user disable --now setlog-bot`。
