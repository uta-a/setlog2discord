# 自宅サーバーへの導入（B5）

setlog Discord Bot を自宅の Ubuntu Server で systemd の常駐サービスとして動かす手順。設計は [design.md](design.md) の 10・11 章。

- 置き場所：`/opt/setlog-bot`（専用ユーザー `setlog-bot` の持ち物）
- サービス：`setlog-bot.service`（ユニットファイルは [`deploy/setlog-bot.service`](../deploy/setlog-bot.service)）
- ログ：`journalctl -u setlog-bot`

コマンドの頭の `[Mac]` は手元の Mac で、`[server]` はサーバーで実行する。

## 大事な注意：Bot は 1 か所でしか動かさない

setlog は同じアカウントの「最後に接続した 1 本」にしか新着を送らない（[api.md 4.9](api.md)）。Mac とサーバーで同時に動かすと、10 分ごとに配信先を奪い合い、取りこぼしと二重の補完が起きる。**サーバーで起動する前に、Mac の Bot を必ず止める。**

## 1. Node.js 26 と pnpm を入れる

Bot は Node 26（`node:sqlite` と chacha20-poly1305）で動作を確認している。

```sh
[server] node -v
```

`v26.` で始まれば次へ。入っていない、または 26 より古い場合は NodeSource から入れる。

```sh
[server] curl -fsSL https://deb.nodesource.com/setup_26.x -o /tmp/nodesource_setup.sh
[server] less /tmp/nodesource_setup.sh        # 中身を確かめてから実行する
[server] sudo bash /tmp/nodesource_setup.sh
[server] sudo apt-get install -y nodejs
[server] node -v                               # v26.x を確かめる
[server] which node                            # /usr/bin/node であること（ユニットファイルが前提にしている）
```

pnpm は Node 25 から同梱されなくなった（corepack が外れた）ので、npm で入れる。手元と同じ 11 系にする。

```sh
[server] sudo npm install -g pnpm@11
[server] pnpm -v
```

## 2. 専用ユーザーと置き場所を作る

ログインできないシステムユーザーにする。

```sh
[server] sudo useradd --system --home-dir /opt/setlog-bot --shell /usr/sbin/nologin setlog-bot
[server] sudo install -d -o setlog-bot -g setlog-bot -m 700 /opt/setlog-bot
```

## 3. コードを置く

サーバーに GitHub の認証情報を置かずに済むよう、Mac で固めて送る。秘密情報は `.gitignore` 済みなので、`git archive` には入らない。

```sh
[Mac]    cd ~/Projects/setlog-webapp
[Mac]    git archive --format=tar.gz -o /tmp/setlog-bot.tgz feat/discord-bot
[Mac]    scp /tmp/setlog-bot.tgz <server>:/tmp/
[Mac]    rm /tmp/setlog-bot.tgz

[server] sudo tar -xzf /tmp/setlog-bot.tgz -C /opt/setlog-bot
[server] rm /tmp/setlog-bot.tgz
[server] sudo chown -R setlog-bot:setlog-bot /opt/setlog-bot
[server] sudo -u setlog-bot pnpm --dir /opt/setlog-bot install --frozen-lockfile --prod
```

`--prod` で、テストと型チェックの道具（vitest・typescript）は入れない。`tsx` は本番の依存に入っている。`/opt/setlog-bot` は専用ユーザーしか入れない（700）ので、`cd` せず `--dir` で場所を渡す。

## 4. 秘密情報を置く

次の 4 つを Mac からサーバーへ送る。**いずれもリポジトリ・チャット・Issue に貼らない。**

| ファイル | 中身 |
| --- | --- |
| `.env.local` | `DISCORD_TOKEN`・`SETLOG_TOKEN`・`SETLOG_USER_ID`・`SETLOG_X_API_KEY` |
| `.secrets.keybackup.json` | setlog の鍵バックアップ |
| `.secrets.passphrase` | 鍵バックアップのパスフレーズ |
| `bot.config.json` | guild・チャンネル・グループの対応 |

```sh
[Mac]    cd ~/Projects/setlog-webapp
[Mac]    scp .env.local .secrets.keybackup.json .secrets.passphrase bot.config.json <server>:/tmp/setlog-secrets/
         # 先に [server] mkdir -m 700 /tmp/setlog-secrets しておく

[server] cd /tmp/setlog-secrets
[server] sudo install -o setlog-bot -g setlog-bot -m 600 .env.local .secrets.keybackup.json .secrets.passphrase bot.config.json /opt/setlog-bot/
[server] rm -rf /tmp/setlog-secrets            # 一時置き場から必ず消す
[server] sudo install -d -o setlog-bot -g setlog-bot -m 700 /opt/setlog-bot/data
[server] sudo ls -la /opt/setlog-bot           # 4 つが -rw------- setlog-bot であること
```

## 5. Mac の Bot を止めて、状態ストアを引き継ぐ

Mac で動いている Bot を止める（`pnpm start` を動かしているターミナルで Ctrl+C）。`#bot-status` に「停止します」が出たら止まっている。

状態ストアを引き継ぐと、投稿済みのメッセージを覚えたまま移れる（引き継がなくても、初回は起動より前のメッセージを流さないので大量には流れない）。Bot を止めてから送る（止める前だと書き込み途中の内容が残る）。

```sh
[Mac]    cd ~/Projects/setlog-webapp
[Mac]    ls data/                              # state.sqlite だけなら次へ。-wal・-shm があれば Bot が止まり切っていない
[Mac]    scp data/state.sqlite <server>:/tmp/

[server] sudo install -o setlog-bot -g setlog-bot -m 600 /tmp/state.sqlite /opt/setlog-bot/data/state.sqlite
[server] rm /tmp/state.sqlite
```

## 6. サービスとして起動する

```sh
[server] sudo cp /opt/setlog-bot/deploy/setlog-bot.service /etc/systemd/system/
[server] sudo systemctl daemon-reload
[server] sudo systemctl enable --now setlog-bot
[server] systemctl status setlog-bot
[server] journalctl -u setlog-bot -f           # 「準備完了」「setlog WebSocket：接続」が出れば動いている
```

`#bot-status` に「起動しました」が出る。友達のクリップかテキストが届くか、chat チャンネルで書いた発言が setlog に届くかを確かめる。

サーバーを再起動しても自動で起動する（`enable` 済み）。

## 7. 更新するとき

```sh
[Mac]    git archive --format=tar.gz -o /tmp/setlog-bot.tgz feat/discord-bot
[Mac]    scp /tmp/setlog-bot.tgz <server>:/tmp/ && rm /tmp/setlog-bot.tgz

[server] sudo systemctl stop setlog-bot
[server] sudo tar -xzf /tmp/setlog-bot.tgz -C /opt/setlog-bot && rm /tmp/setlog-bot.tgz
[server] sudo chown -R setlog-bot:setlog-bot /opt/setlog-bot
[server] sudo -u setlog-bot pnpm --dir /opt/setlog-bot install --frozen-lockfile --prod
[server] sudo cp /opt/setlog-bot/deploy/setlog-bot.service /etc/systemd/system/ && sudo systemctl daemon-reload
[server] sudo systemctl start setlog-bot
```

`git archive` は秘密情報と `data/` を含まないので、上書きしても消えない。

## 困ったとき

| 症状 | 見るところ・対処 |
| --- | --- |
| 起動してすぐ止まる | `journalctl -u setlog-bot -n 50`。設定ファイル・鍵・パスフレーズの誤りは、その項目名が出る。10 分に 5 回落ちると systemd が止めるので、直したら `sudo systemctl reset-failed setlog-bot && sudo systemctl start setlog-bot` |
| 「Used disallowed intents」で起動しない | Discord Developer Portal で Bot の MESSAGE CONTENT INTENT を有効にする |
| `#bot-status` に「トークンが失効した」 | Mac で `tools/setlog-login.ts` の start・verify をやり直し、新しい `.env.local` と `.secrets.keybackup.json` を 4 の手順で置き直して `sudo systemctl restart setlog-bot` |
| 新着が届かない | スマホで setlog アプリを開いていると Bot に届かない。10 分以内に戻るのを待つか、Discord で `/reconnect` |
| Mac でも動かしてしまった | どちらかを止める。止めた方の状態ストアは使わない |

止めるとき：`sudo systemctl disable --now setlog-bot`。
