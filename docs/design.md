# setlog Discord Bot 設計書

Nov 18, 2026 · @uta\_a

> 2026-11-18 に Web ビューア（Next.js + Cloudflare）から Discord Bot に方針を変えた。旧設計は git 履歴（`2a2ae4d` 以前の `docs/design.md`）に残している。API 解析（フェーズ0）の結果と `lib/setlog/` はそのまま引き継ぐ。

## 1. 概要

setlog の友達の新着（2秒クリップとグループのテキストチャット）を、自分専用の Discord サーバーに流す Bot を作る。Discord から setlog のグループチャットへ返信（テキスト・画像・動画）もでき、友達の投稿に付けたリアクションも setlog に同期する。Bot は自宅の Ubuntu Server で常駐させる。

**目的**

- 友達のクリップが投稿されたら、復号した mp4 をグループごとのチャンネルにすぐ投稿する
- グループのテキストチャットを Discord で読み、Discord から返信する（画像・動画も送れる）
- Discord で友達の投稿に付けたリアクションを、setlog の同じ投稿にも付ける

**スコープ**

- 友達のクリップと写真の自動投稿（setlog → Discord）
- 友達のテキストの転送（setlog → Discord）
- 自分のテキストの送信（Discord → setlog）
- 自分の画像・動画の送信（Discord → setlog。グループのチャットに写真・動画として送る。2026-11-23 に追加）
- 友達の投稿へのリアクションの付け外し（Discord → setlog。2026-11-23 に追加）

**スコープ外**

- 自分がスマホから送ったテキスト・撮ったクリップの転送（第4章のとおり WebSocket に流れてこないため、流さないと決めた）
- 1日分の Vlog（連結動画）の投稿、過去の日をコマンドで呼び出す機能（必要になったら追加する）
- 既読を付けること。`typing` を送ること
- Discord からクリップ（2秒動画のフィード、`type=collection`）への投稿。画像・動画はチャットの写真・動画（`type=snap`）として送る（7.4）
- setlog で友達が付けたリアクションを Discord に出すこと
- 自分以外が Discord サーバーに入ること、複数の setlog アカウント

## 2. 前提と制約

前提は「自分のアカウントの API を、自分だけが使う」こと。この前提が崩れる機能は作らない。

- **Discord サーバーには自分しか入らない**：友達の動画とテキストを置く場所なので、他人は招かない。Bot は設定した guild ID 以外では動かない
- **友達から見える挙動を変えない**：既読（`updateReadTimestamp`）も入力中（`typing`）も送らない。友達に見える書き込みは、自分が Discord で書いたテキスト・画像・動画の送信と、友達の投稿へのリアクションの付け外しだけ（2026-11-23 に画像・動画とリアクションを足した）
- **リクエスト頻度**：アプリ並みかそれ以下。新着は WebSocket で受け、REST は起動時と再接続時の補完にだけ使う
- **API 仕様**：予告なく変わる。setlog を知るのは `lib/setlog/` だけにし、zod 検証で形の変化を検知する
- **日付と時間枠**：アプリの表示に合わせ、Asia/Tokyo の 04:00 起点で計算する（`lib/setlog/transform.ts` の `toDateHour`）

## 3. 全体構成

```
                     自宅 Ubuntu Server（systemd で常駐）
  ┌──────────┐  WebSocket   ┌──────────────────────────────────────┐  Gateway / REST  ┌──────────────┐
  │ setlog   │─────────────▶│  bot/                                │◀────────────────▶│ Discord      │
  │ ws.*     │  newMessage  │   setlog-stream  受信・再接続・補完   │                  │ 自分専用      │
  ├──────────┤              │   clips          復号 → mp4 投稿      │   mp4・テキスト    │ サーバー      │
  │ api.*    │◀────────────▶│   chat           転送・送信           │─────────────────▶│              │
  │ media.*  │  REST / CDN  │   state.sqlite   投稿済み・対応表     │                  │              │
  └──────────┘              │  lib/setlog/     API・暗号・変換       │◀─ 自分の発言 ─────│              │
                            └──────────────────────────────────────┘                  └──────────────┘
```

- `lib/setlog/`：API クライアント、zod スキーマ、変換、E2EE 復号・暗号化（既存。setlog を知っているのはここだけ）
- `bot/`：Discord 接続、setlog の WebSocket 受信、クリップ投稿、チャット中継、状態の保存

## 4. setlog からの受信

新着は WebSocket で受け、取りこぼしは REST で埋める。根拠は [api.md 4.9](api.md)。

**WebSocket**

- `wss://ws.newchatapi.com/` に `jwt-key` ヘッダーを付けて接続する。購読のフレームは送らない（接続すれば参加中の全会話のイベントが届く）
- `newMessage` にメッセージ本体が載る。テキストは `type=chat`・`contentType=text/plain`、クリップは `type=collection`・`contentType=video/mp4`
- 他の action（`messageUpdate`、`messageDeleted`、`readReceipt`、`typing` など）は当面ログに残して無視する
- サーバーは 30 秒ごとに ping を送る。90 秒以上 ping が来なければ切れたとみなして張り直す。ping を受け取り、接続時の HTTP 401（トークン失効）を通信断と区別するため、Node 組み込みの `WebSocket` ではなく `ws` パッケージを使う（[api.md 4.9](api.md)）
- **5 分ごとにこちらから閉じてつなぎ直す**（2026-11-19 に 5 分から 10 分に変え、同日 5 分に戻した）。setlog は同じアカウントの「最後に接続した 1 本」にしか新着を送らず、スマホでアプリを開くとそちらに移る。Bot の接続は切られないまま届かなくなる（その場で検知する手段は無い）ので、定期的につなぎ直して配信先に戻る（[api.md 4.9](api.md)、2026-11-19）。REST の補完は 10 分ごと（定期のつなぎ直し 2 回に 1 回。1 グループ 1 日 144 回）。起動・切断からの再接続・`/reconnect` では毎回補完する（2026-11-19 に決めた。`bot/backfill-gate.ts`）。逆に、アプリを開いている間も Bot がつなぎ直すとアプリから配信先を奪う（アプリの画面にリアルタイムで出なくなる。プッシュ通知は届く見込み）。Bot を優先すると決めた
- **`/reconnect`**：すぐつなぎ直して補完するスラッシュコマンド。設定した guild にだけ登録し、使えるのは `ownerUserId` だけ。返事は本人にだけ見える。登録は起動時にはせず、`tools/register-commands.ts` で行う（起動のたびの登録が頻度制限に当たり、起動が遅れたため）
- 再接続はアプリと同じバックオフ（1, 2, 4, 8, 16, 32 秒で頭打ち）。**close code `4403`（アカウントロック）を受けたら再接続せず、停止して通知する**
- バックオフの回数は、接続が 30 秒以上続いてから切れたときだけ戻す（つないですぐ切られる状態で 1 秒ごとに叩き続けないため）
- 401 と `4403` で受信を止めても、プロセスは終了しない（systemd の再起動で setlog への接続を繰り返さないため）

**自分の発言は届かない**

サーバーは送信者本人のアカウントの接続には新着を流さない（実測）。このため：

- 自分がスマホで送ったテキスト・撮ったクリップは Bot に届かない。Discord には流さない（スコープ外）
- Discord から setlog に送った発言が WebSocket で戻ってきて二重になることもない
- REST の補完では自分の発言も返ってくるので、**`senderId` が自分のメッセージはすべて捨てる**

**REST による補完**

サーバーはイベントを再送しないので、次のタイミングで `GET chat/{conversationId}/messages?limit=40&beforeTimestamp=<現在時刻>` を対象グループごとに 1 回ずつ叩く。パラメータなしだと当日分しか返らないので、`beforeTimestamp` は必ず付ける。

- Bot の起動時
- WebSocket の再接続に成功したとき

- **未処理かどうかは `messageId` だけで判定する**。クリップの `timestamp` は撮影時刻で、届くのは数秒以上後になる（実測 9 秒）。その間に届いたテキストの方が時刻が新しいので、「最後に処理した時刻より新しいもの」で絞ると遅れて届いたクリップを落とす
- `timestamp` は下限としてだけ使う。**初回起動時（状態ストアが空のとき）は起動時刻より前のメッセージを流さない**。それ以降は、最後に処理した時刻から 24 時間前を下限にする。**ただし、その会話を Bot が見始めた時刻より前は流さない**（`watched_conversations`）。24 時間前だけだと、会話を設定した直後に 1 件記録したあとの補完（`/reconnect` など）で、見ていなかった前日のクリップまで流れた（2026-11-19）。見始めた時刻は、初めて補完したときの起動時刻にする。この表を足す前から見ていた会話は、記録済みのいちばん古いメッセージの時刻にする
- 1 回の補完は直近 40 件まで（長時間止まっていた場合の古い分は流さない。必要なら手動でさかのぼる）
- 補完の処理と WebSocket のイベントは、会話ごとに直列で処理する（同じ `messageId` を同時に処理して二重投稿しないため）

## 5. 認証と鍵

**setlog のトークン**

- メール OTP で取得した `jwt-key` を使う。HS256 JWT で `exp` もリフレッシュトークンも無いので、実質長期有効（[api.md](api.md) 第2章）
- 失効（401）したら自動回復はできない。Bot は受信を止め、Discord の `#bot-status` に「トークンの再登録が必要」と投稿する。再登録は手でメール OTP をやり直し、`.env` を差し替えて再起動する

**E2EE の秘密鍵**

- 動画とテキストの復号、テキストの送信に、自分の X25519 秘密鍵が要る。鍵バックアップ（`GET auth/key-backup`）とパスフレーズを Bot のホストに置き、起動時に `recoverPrivateKeyFromBackup` で復元してメモリに持つ。場所は `BOT_KEY_BACKUPS`（カンマ区切り、既定 `.secrets.keybackup.json`）と `BOT_PASSPHRASE_FILE`（既定 `.secrets.passphrase`）。復元できなければ起動しない
- **鍵の世代（`kid`）**：端末を再登録すると鍵がローテーションし、旧鍵で暗号化されたものは新鍵で開けない。鍵は `kid` ごとに複数持てる形にし、メッセージの自分宛エントリの `kid` で選ぶ。合う鍵が無いメッセージはスキップして `#bot-status` に通知する（Bot 全体は止めない）

## 6. Discord 側の構成

**チャンネル**

| チャンネル | 中身 |
| --- | --- |
| `#<グループ名>-clips` | 友達のクリップ（mp4 添付） |
| `#<グループ名>-chat` | 友達のテキストの転送と、自分の返信 |
| `#bot-status` | 起動・停止、トークン失効、復号失敗、API 仕様変更の通知 |

グループ（setlog の `conversationId`）とチャンネルの対応は設定ファイル（`bot.config.json`）で持つ。Bot はチャンネルを自動では作らない。同じグループなら `clipsChannelId` と `chatChannelId` を同じチャンネルにしてもよい（クリップとテキストが 1 つのチャンネルに流れる）。`#bot-status` や別グループとの共有はできない。今回のグループではクリップ（collection）とチャット（chat）の `conversationId` が同じ値だったが、別の値のグループがあれば設定で両方を書けるようにする。

**特定の人の投稿を流さない**（2026-11-19 に追加）：`bot.config.json` の `ignoredSenderIds` に setlog のユーザー ID を書くと、その人のクリップ・写真・音声・テキストを全グループで流さない（WebSocket でも補完でも捨て、状態ストアにも記録しない）。ユーザー ID は `tools/list-members.ts` で調べる。設定を変えたら再起動する。除外を外すと、外す前の分も補完の範囲（最後に処理した時刻の 24 時間前まで）なら流れる。

**投稿の形**

- クリップ：カード（Components V2 のコンテナ）の中に、送信者の名前 1 行（太字）と、その下に mp4。左の帯はその人の `tintColor`。日付・グループ名は出さない（2026-11-19 に決めた）。従来の embed には Bot から動画を入れられず、添付は embed の上に出てしまうため、この形にした
- アイコン：メディア CDN の `avatarUrl`（暗号化されていない。拡張子は `.heic` でも中身は JPEG）を Bot が取得し、友達の Webhook のアイコンに設定する（Discord に setlog の URL を渡さない。中身が JPEG・PNG・WebP・GIF でなければ使わない）。カードと embed の中にはアイコンを出さない（2026-11-19 に Webhook の投稿者のアイコンにしたので外した）
- `tintColor` は `#RRRRGGGGBBBBAAAA`（各成分 16 ビット）の形で返るので、上位 8 ビットを使う
- 友達のテキスト：クリップと同じ形の embed。本文にテキスト（Markdown はエスケープして書いたとおりに見せる。URL は自動でリンクになる）、タイムスタンプに送信時刻。Webhook は使わない（2026-11-19 に embed に変えた）
- メンバー名とアバターは `GET chat/message/participantKeys` と `collections` の参加者情報から取り、起動時と `collectionJoined` などのイベントで更新する

**Bot の権限と intent**

- 必要な権限：対象チャンネルの閲覧・送信・ファイル添付・埋め込みリンク・メッセージ履歴を読む（失敗の返信のため）・**Webhook の管理**（友達の名前で投稿するため。無ければ Bot として投稿し、`#bot-status` に 1 回知らせる）

**友達の名前で投稿する**（2026-11-19 に追加）：Discord の通知には投稿者の名前が出るので、Bot のまま投稿すると「setlog」としか出ず誰の投稿か分からない。クリップ・写真・音声・テキストの投稿先チャンネルごとに Bot が作った Webhook を 1 つ持ち、username を友達の名前にして投稿する（`bot/webhooks.ts`）。アイコンも友達のものにする（2026-11-19 に追加）：setlog のアイコンは CDN で `image/heic` として配信され中身が HEIC の人もいるので、Discord に URL（`avatar_url`）は渡せない。そこで友達ごとに Webhook を作り（名前は `setlog <userId>`）、Bot が取得した画像を Webhook のアイコンに設定する。起動後に初めて使うときと、アイコンが変わったときに設定し直す。アイコンが無い人と、1 チャンネルの Webhook の上限（15 個）に達したときは共用の Webhook（Bot のアイコン）で投稿する。Webhook は Discord の返信を作れないので、友達の返信は本文の上に返信先へのリンクを 1 行足す。Webhook には nonce が無いので、応答が失われて送り直すと二重に投稿されうる（頻度は低いので許容する）。Webhook が消されていたら探し直し、その回は Bot として投稿する。`#bot-status` の通知は Bot のまま
- 発言の本文を読むので MESSAGE_CONTENT intent が要る（自分のサーバーだけなので、Developer Portal で有効にするだけで足りる見込み。実装時に確認する）
- リアクションの同期（7.5）に `GuildMessageReactions` intent が要る（特権 intent ではないので Developer Portal の設定は要らない）。再起動前の投稿はキャッシュに無いので、Partials（Message・Reaction・User）を有効にして受け取る。追加のチャンネル権限は要らない
- `guildCreate` で設定外の guild に入れられたら、即座に退出する

## 7. 機能

### 7.1 クリップの投稿（setlog → Discord）

1. `newMessage` で `contentType=video/mp4` か `video/quicktime`（iPhone から撮ったもの。2026-11-19 に実物を確認して追加。`.mov` で投稿する）を受ける。送信者が自分なら捨てる
2. `messageId` が投稿済みなら捨てる（状態ストアで確認）
3. `keys[]` の自分宛エントリで content key をアンラップする（`unwrapContentKey`）
4. `media.path` を `https://media.newchatapi.com/` から取得し、`decryptMedia` で mp4 に戻す
5. `#<グループ名>-clips` に投稿し、`messageId` と Discord のメッセージ ID を状態ストアに記録する

写真（`type=snap`、`contentType=image/jpeg` など）も同じ手順で扱う。暗号と CDN の仕組みはクリップと同じで、同じカードで投稿する（2026-11-19 に追加）。状態ストアの種類の列は `clip`・`text` だけなので、写真は `clip` として記録する。

音声メッセージ（`type=snap`、`contentType=audio/mp4` など）も同じ手順で扱う（2026-11-19 に追加）。音声は動画・画像の枠（MediaGallery）に入らないので、カードの中にファイルの部品で出す。状態ストアには `clip` として記録する。

**音声を mp3 にする**（2026-11-23 に追加）：ファイルの部品に `.m4a` を入れると、Discord はプレイヤーを出さずファイルのリンクにする。そこで `audio/mp4`・`audio/aac` の音声は ffmpeg で mp3 にしてから投稿する（`bot/audio.ts`。ffmpeg はサーバーに入れる。[deploy.md](deploy.md) の 1 章）。Discord のボイスメッセージ（波形つき）は Webhook では送れず、本文も付けられないので使わない。m4a は moov が末尾にあると標準入力から読めないので、入力と出力は一時ファイルにする（本人だけが読める一時ディレクトリに作り、終わったら消す）。音声は友達が送った未信頼のデータなので、ffmpeg は shell を通さず固定の引数で起動し、入力の形式を mime から固定し、プロトコルは `file` だけを許し、30 秒と 25 MB の上限を付ける。変換できないとき（ffmpeg が無い・壊れている・上限超え）は元の `.m4a` のまま投稿し、`#bot-status` には起動中に 1 回だけ知らせる（メッセージは失わない）。

**タイトル**（2026-11-19 に追加）：クリップと写真にキャプション（`media.captions[].text`。暗号化されていない平文）があれば、カードの名前の下・動画の上に見出しで出す。キャプションごとに 1 行。友達が自由に書けるので Markdown として解釈させず、制御文字を除いて 200 文字で切る。形が違っても投稿は止めない。

失敗したとき：

- 復号失敗（自分宛の鍵が無い、`kid` 不一致など）、形の違い、大きすぎるもの、CDN の 403・404・410：再試行せず、`failed` で記録して `#bot-status` に通知する。あとから鍵を足しても、`failed` で記録したクリップは流れない
- CDN の取得失敗（5xx・通信断・タイムアウト・途中で切れた本体）：バックオフして 3 回まで再試行する。それでも失敗したら記録せず、残っている間は 5 分ごとの REST 補完で拾い直す（2026-11-19 に 10 分から変えた）（自宅回線の一時的な切断でクリップを失わないため）。通知は同じメッセージにつき 1 回
- Discord への投稿失敗：記録せず、同じく拾い直す。添付の上限超えだけは `failed`。投稿には `messageId` から作った nonce を付け、送り直したときの二重投稿を Discord 側で弾く
- 削除済み（REST の `isDeleted`）：投稿せず `skipped` で記録する

メンバー名は `collections` の参加者から引き、引けなければ「メンバー」とする（REST の `senderName` は空文字で返る）。名前は友達が自由に付けられるので、改行と制御文字を除いて 64 文字に切る（embed の author は Markdown を解釈しない）。

### 7.2 テキストの転送（setlog → Discord）

1. `newMessage` で `contentType=text/plain` を受ける。送信者が自分なら捨てる
2. 処理済みでなければ `decryptText` で復号する（自分宛エントリの `kid` で鍵を選ぶ）
3. `#<グループ名>-chat` に embed で投稿し、対応を記録する

返信（`parentId` あり）は、対応表に元のメッセージがあれば Discord の返信として投稿する。無ければ普通の投稿にする。対応表は、Bot が投稿したもの（`processed_messages`）と Discord から送った自分の発言（`sent_messages`）の両方を引く（友達が自分の発言に返信したときも返信にするため）。ただし WebSocket の `newMessage` には `parentId` が無い（`lib/setlog/text.ts`）ので、WebSocket で先に届いたものは普通の投稿になり、返信として出るのは REST の補完で拾ったものだけ。REST の `parentId` は返信でなければ空文字で返る（実測。返信の実例はまだ無い）。

失敗の扱いはクリップと同じ。復号できない・形が違うものは `failed`、投稿の失敗は記録せず 5 分ごとの補完で拾い直す、削除済みは `skipped`。

**転送を始める前の分は流さない**：B2 から cursor が進んでいるので、そのままだと B3 の初回起動で直近 24 時間のテキストが最大 40 件流れる。会話でテキストを 1 件も記録していない間は、テキストの補完の下限をプロセスの起動時刻にする。記録してからは、初めて記録したテキストの時刻を下限にする（cursor の 24 時間前まで広げても B3 以前には戻らない）。表は変えず `processed_messages` から判定する。1 件目を記録する前に再起動すると、止まっていた間のテキストは流れない。

### 7.3 テキストの送信（Discord → setlog）

送るのは **`#<グループ名>-chat` での、設定した自分の Discord ユーザー ID の発言だけ**（クリップと同じチャンネルなら、そこでの自分の発言はすべて送る。2026-11-19 に決めた）。Bot 自身の発言、Webhook、システムメッセージ、DM、ほかの guild は送らない。

1. `messageCreate` を受け、guild・チャンネル・送信者を確かめる（`bot/guard.ts` の `sendTarget`）
2. `getParticipantKeys` で参加者の公開鍵と `kid` を取る。**実物は自分を含まなかった**（2026-11-19）ので、自分の `kid` と公開鍵は `GET user/profile` から取り、手元の鍵の公開鍵と一致するか確かめる（合わなければ送らない。端末の再登録で鍵が変わったときに、友達が読めないものを送らないため）。どちらも 60 秒キャッシュする
3. 参加者と自分宛に `encryptText` で暗号化し、`sendTextMessage` で送る。返ってきた `messageId` を `sent_messages` に記録する
4. **成功しても何もしない。失敗したときだけ、元の発言に「Not sent: 理由」と返信する**（絵文字のリアクションは使わない。2026-11-19 に決めた）

**Discord の返信は setlog の返信にする**（2026-11-19 に追加）。Discord で Bot の投稿（クリップ・写真・友達のテキスト）か自分が送った発言に返信すると、対応する setlog のメッセージを `parentId` にして送る。返信先は `processed_messages`（posted）と `sent_messages` から Discord のメッセージ ID で引く。返信先が setlog のメッセージでない（Bot の通知・失敗の返信など）か、送り先と別の会話のものなら送らず、失敗として返信する（黙って普通の発言にすると、返信になっていないことに気づけないため）。Discord の転送（forward）は返信として扱わない。

本文はメンションを表示名に直して送る（`cleanContent`）。スタンプは送らず、「送れない」と返信する。空の発言と 2000 文字を超える発言も送らない。添付（画像・動画）は 7.4 のとおり送る（2026-11-23 までは送らずに返信していた）。

### 7.4 画像・動画の送信（Discord → setlog）

2026-11-23 に追加。7.3 と同じ条件（`#<グループ名>-chat` での自分の発言）で、添付した画像・動画を setlog のグループのチャットに送る。アプリのチャット画面から写真・動画を送るのと同じ形（`type=snap`）にし、2秒クリップのフィード（`type=collection`）には入れない。形は APK（1.3-89）の静的解析による（[api.md 4.10](api.md)）。**実 API ではまだ確かめていない。**

1. 発言をテキストと添付に分け、その順に 1 つずつ別のメッセージとして送る（setlog のメッセージは本文か画像・動画のどちらか 1 つを持つため）。添付だけの発言ならテキストは送らない
2. 送れる形式は JPEG・PNG・WebP・MP4・MOV（アプリが拡張子を知っているもののうち、Discord から来るもの）。上限は 1 つ 50 MB（setlog 側の上限は分かっていない）。形式と大きさは Discord の添付の情報で取得前に確かめ、送れないものは取得しない
3. 添付は Discord の CDN（`cdn.discordapp.com`・`media.discordapp.net` の https）からだけ取得し、リダイレクトはたどらない（`bot/attachments.ts`）
4. 宛先と鍵の確かめ方は 7.3 と同じ。`encryptMedia` で暗号化する：ファイル全体を 1 回の ChaCha20-Poly1305 で封じ（nonce 12 バイト + 暗号文 + tag 16 バイト）、AAD は v1 の content info（`msg:enc:v1|conv:{conversationId}|msg:{messageId}|sender:{自分}|type:{MIME}`）。content key は 7.3 と同じく参加者と自分宛にラップする
5. `POST https://api-kr.newchatapi.com/media/getUploadURL` で置き場所を発行してもらい（リージョンは `ap-northeast-2`。アプリは日本のロケールでこれを選ぶ）、返った `uploadUrl` に暗号文を `PUT` する（setlog のトークンは付けない）。`uploadUrl` が https でなければ送らない
6. `POST chat/{conversationId}/message` で `type=snap` のメッセージを送る。`media.path` は発行された `key`、`contentType` と `media.mimeType` は暗号化に使った MIME、`mediaCipherV` と鍵エントリの `v` は 1（アプリが撮影してチャットに送る経路での値。受信側は v1・v2 の AAD を両方試す）。幅・高さは Discord の添付が持っていれば `media.dimensions` に入れる。`permission` は `allow_saving`
7. 返信先（`parentId`）は最初に送れた 1 件にだけ付ける。`sent_messages` には最初に送れた 1 件を記録する（表は Discord の発言 1 件につき 1 行のまま）

送れないものがあっても残りは送り、送れなかったものを名前と理由付きで元の発言に返信する。メッセージの送信は自動で送り直さない（応答が失われただけなら友達の画面で二重になるため）。

添付の取得とアップロードは発言ごとに進むので、画像を送った直後に次の発言でテキストを送ると、setlog ではテキストが先に並ぶことがある（許容する）。

### 7.5 リアクションの同期（Discord → setlog）

2026-11-23 に追加。Discord で友達の投稿（Bot が流したクリップ・写真・音声・テキスト）に自分がリアクションを付けたら、setlog の同じメッセージにも同じ絵文字を付ける。外したら setlog でも外す。形は APK（1.3-89）の静的解析による（[api.md 4.11](api.md)）。**実 API ではまだ確かめていない。**

1. 対象は、設定した guild のクリップ・チャットのチャンネルで、設定した自分のユーザーが付け外しした Unicode の絵文字だけ（`bot/guard.ts` の `reactionEmoji`）。サーバーのカスタム絵文字は setlog に無いので送らない
2. 対象の投稿を `processed_messages` の posted から Discord のメッセージ ID で引く（`postedMessageOf`）。自分が Discord から送った発言、Bot の通知などは黙って無視する
3. 付けたら `POST chat/message/addReaction`（`conversationId`・`messageId`・`id`（UUID）・`text`（絵文字）・`factor`・`scale`）、外したら `POST chat/message/removeReaction`（`conversationId`・`messageId`・`text`）を送る。`conversationId` は投稿を記録した行のもの（クリップは collection 側）

失敗したら `#bot-status` に知らせ、送り直さない。setlog で友達が付けたリアクションは Discord に出さない。Bot が止まっている間に付け外ししたものは同期されない。

## 8. 状態の保存

再起動しても二重投稿しないことを完了条件にする。Node 組み込みの `node:sqlite` で 1 ファイル（`data/state.sqlite`）に持つ。

| テーブル | 中身 |
| --- | --- |
| `processed_messages` | setlog の `messageId`、`conversationId`、種別（clip / text）、`timestamp`、Discord のメッセージ ID、結果（posted / skipped / failed）、処理した時刻 |
| `sent_messages` | Discord のメッセージ ID と、送信した setlog の `messageId`、`conversationId`、送信した時刻 |
| `watched_conversations` | 会話ごとに Bot が見始めた時刻（REST 補完でこれより前を流さない） |
| `cursors` | 会話ごとの最後に処理した `timestamp`（REST 補完の下限を決めるのに使う。未処理の判定には使わない） |

投稿したあと記録する前にプロセスが落ちると、次の補完でもう一度投稿されうる（nonce が効く数分を過ぎた場合）。頻度は低いので許容する。

復号した mp4 は Discord に投稿したら手元には残さない。ローカルに保存するかは、必要になったら決める。

## 9. エラーと通知

通知はすべて `#bot-status` に Bot が投稿する。**Discord に出す Bot のシステム文言（`#bot-status` の通知、送信失敗の返信、`/reconnect` の応答）は英語にする**（2026-11-19 に決めた。下の表の「」内は意味。ログは日本語のまま）。

| 事象 | 動き |
| --- | --- |
| setlog の 401 | 受信を止めて「トークンの再登録が必要」と通知 |
| close code `4403` | 再接続を止めて「アカウントロックの可能性」と通知 |
| zod 検証の失敗 | 「API 仕様変更の可能性」と、そのイベントの action とキー名を通知（本文は出さない）。他のイベントの処理は続ける |
| 復号失敗 | メッセージをスキップして通知 |
| WebSocket の切断 | バックオフで再接続。5 分以上つながらなければ通知 |

ログに setlog のトークン、Discord のトークン、パスフレーズ、メッセージ本文は出さない。

## 10. セキュリティ

この Bot は、旧設計より信頼境界を広げる。次のリスクを受け入れたうえで作る。

- **復号した友達の動画とテキストが Discord に保存される**：旧設計では「自分専用の非公開バケット」だけに置く前提だった。Discord の運営側からは見える状態になる。サーバーに他人を招かないことでほかの利用者からは見えないようにし、Bot は設定外の guild では動かない
- **E2EE の秘密鍵がスマホの外に出る**：鍵バックアップとパスフレーズを自宅サーバーに置く。専用の OS ユーザーで動かし、`.env` と鍵ファイルは `chmod 600`。リポジトリにはコミットしない（`.gitignore` の `.secrets.*`）
- **トークンが 3 つある**：setlog の `jwt-key`、Discord の Bot トークン、Webhook の URL。どれも `.env` か状態ストアにだけ置き、ログと通知に出さない
- **誤送信は友達に見える**：送信は 7.3 の条件（チャンネル＋自分のユーザー ID）に限る。画像・動画（7.4）も同じ条件、リアクション（7.5）は設定したチャンネルでの自分の付け外しで、対象は友達の投稿だけ
- **外部から取ってくるもの・送る先**（2026-11-23 に追加）：添付は Discord の CDN の https だけから取得し、リダイレクトをたどらず、大きさに上限を設ける。暗号文の置き場所（`uploadUrl`）は setlog が返す値なので https であることだけを確かめる（ホストは確かめていない。中身は暗号文で、setlog のトークンは付けない）。失敗の返信・通知に署名付き URL は出さない
- **リポジトリ**：GitHub は private のまま。フィクスチャは伏せ字のものだけ

## 11. 技術スタック・運用

| 層 | 採用 | 備考 |
| --- | --- | --- |
| 実行環境 | Node 26 以上（`crypto` の chacha20-poly1305、`node:sqlite`）＋ tsx | `package.json` の `engines` に書いた。手元は v26.11.1 |
| setlog WebSocket | `ws` | ping の監視と 401 の判別のため（組み込み `WebSocket` では取れない） |
| Discord | discord.js | バージョンは導入時の最新安定版 |
| setlog | `lib/setlog/`（既存） | API・暗号・変換 |
| 型・検証 | TypeScript、zod | 既存 |
| 状態 | SQLite（`node:sqlite`） | `data/state.sqlite` |
| テスト | vitest | 既存 |
| 常駐 | ユーザー単位の systemd（`rakko-server` のユーザー `uta`、`~/vscode/discord/bots/setlog/`、`Restart=on-failure`、linger 有効） | ユニットファイルは `deploy/setlog-bot.user.service`、手順は [deploy.md](deploy.md)。専用ユーザー版は `deploy/setlog-bot.service`（未使用） |

**リポジトリ構成**

```
bot/            # Discord Bot（エントリ、setlog 受信、クリップ、チャット、状態）
lib/setlog/     # API クライアント、スキーマ、変換、暗号（ここだけが setlog を知る）
docs/           # 設計書と API 解析
fixtures/       # 伏せ字済みのレスポンス例
tools/capture/  # 解析用のキャプチャツール
```

Next.js 関連（`app/`、`lib/bff.ts`、`next.config.ts`、`AGENTS.md`）は削除する。

## 12. フェーズ

**フェーズ0：API 解析**（完了）

- [x] バックエンドの特定、通信のキャプチャ、認証方式の確定
- [x] E2EE の復号（動画・テキスト）とテキスト送信の検証
- [x] WebSocket によるリアルタイム受信の確認（[api.md 4.9](api.md)）

**フェーズ1：Bot**（完了条件：友達のクリップとテキストが Discord に届き、Discord から返信でき、再起動しても二重投稿しない）

- [x] B0：Next.js を外して Bot の骨組み（Discord 接続、guild 制限、設定、`#bot-status`）
- [x] B1：setlog の WebSocket 受信、再接続、REST 補完、状態ストア（受け取ったことをログに出すまで。状態ストアへの記録は B2・B3 で始める）
- [x] B2：クリップの復号と投稿
- [x] B3：テキストの転送（setlog → Discord）
- [x] B4：テキストの送信（Discord → setlog）
- [x] B5：自宅サーバーへの導入（systemd）。2026-11-19 に `rakko-server` の `~/vscode/discord/bots/setlog/` へ、ユーザー単位の systemd で導入した（[deploy.md](deploy.md)）

**フェーズ2：任意**

- [ ] 1日分の Vlog を ffmpeg で連結して投稿
- [ ] 過去の日をスラッシュコマンドで呼び出す
- [ ] 自分の投稿も REST で拾って流す
- [x] Discord から画像・動画を送る（7.4）、友達の投稿へのリアクションを同期する（7.5）。2026-11-23 に実装。実 API での確認はまだ

## 13. 未確定事項・リスク

**未確認**

- ~~Bot が 2 本目の WebSocket 接続を張ったとき、スマホのアプリの受信に影響が出ないか~~ → 影響は両方向にある。新着は「最後に接続した 1 本」にだけ届くので、アプリを開くと Bot に届かなくなり、Bot がつなぎ直すとアプリに届かなくなる（[api.md 4.9](api.md)、2026-11-19 実測）。5 分ごとのつなぎ直しと `/reconnect` で Bot を優先する（2026-11-19 に決めた）
- `messageUpdate`・`messageDeleted` などの実際の形
- 長時間接続の安定性と、サーバー側から切られる間隔
- グループによってクリップとチャットの `conversationId` が分かれるか
- bot 対策・レート制限・IP 制限の閾値
- 画像・動画の送信（7.4）とリアクション（7.5）の実際の挙動。とくに、送った写真・動画が友達の端末で開けるか（暗号の形）、`getUploadURL` の応答の形、`addReaction` の応答と、同じ人が同じメッセージに複数付けられるか

**リスクと対応**

| リスク | 影響 | 対応 |
| --- | --- | --- |
| アプリ更新で API や WebSocket の形が変わる | 新着が届かなくなる | zod 検証で検知して `#bot-status` に通知 |
| トークン失効（リフレッシュ無し） | 新着が止まる | 401 で停止して通知、手でメール OTP をやり直す |
| 端末再登録で鍵がローテーション | 新しいメッセージが旧鍵で開けなくなる（逆も） | 再登録の前後で鍵バックアップを取り直し、`kid` ごとに保持する |
| WebSocket が黙って切れる | 新着を取りこぼす | ping の監視で検知して再接続し、REST で補完する |
| サーバーが Bot の接続に新着を送らない（最後に接続したアプリ側に送る） | ping は届くので気づけず、つなぎ直すまで取りこぼす | 5 分ごとにつなぎ直して補完する。急ぐときは `/reconnect`。アプリからは配信先を奪う |
| 秘密鍵・動画が自宅サーバーと Discord に置かれる | E2EE の信頼境界が広がる | 第10章の対策。サーバーに他人を招かない |
| 誤送信 | 友達に見える | 送信はチャンネルと自分のユーザー ID で限定 |
