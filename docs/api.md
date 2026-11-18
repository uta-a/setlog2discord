# setlog API 仕様（解析メモ）

フェーズ0 の成果物。完了条件は「6 操作分の仕様が埋まっていること」（[設計書 第13章](design.md)）。

- 解析対象のパッケージ：`com.newchat.setlog`
- 解析日：静的 2026-11-18（jadx）／**動的 2026-11-18（mitmproxy キャプチャ）**
- 動的解析の手順とツールは [dynamic-analysis.md](dynamic-analysis.md)。生のキャプチャは `captures/`（git 管理外）、伏せ字済みだけ `fixtures/`（[fixtures/README.md](../fixtures/README.md)）

詳細と根拠（ファイル:行）は [static-analysis.md](static-analysis.md) を参照。ここは要点のみ。状態：静的＝jadx で確認、動的＝キャプチャで確認、未＝未確認。

## 0. 動的解析の確定結果（2026-11-18）

実機（パッチ版で user CA を信頼させた setlog）を mitmproxy で傍受し、下記を実測で確定。詳細な数値は各節と `fixtures/` 参照。

- **認証は `jwt-key` のみ必須**（外すと 401）。`x-api-key` は `/collections` では**強制されない**（外しても 200）。署名・端末証明なし → **方式 A（BFF 中継）がメタデータで成立**。
- **トークンは HS256 JWT、payload は `{userId, iat}` のみで `exp` なし**。`GET user/profile` は `token` を返さず**ローテーションしない** → 実質長期有効（失効はサーバー側判定のみ）。
- **ソロログは `GET collections` に含まれる**（`type=collection`, `roomType=log`/`vlog`）。**DM は別経路 `GET chat/conversations`**。`lastEvaluatedKey` は今回 null。
- 日別は 2 形式が通る：アプリ既定は `?limit&beforeTimestamp`、**日レンジ `?startTimeInterval&endTimeInterval` も 200**。
- **メッセージの `media` は配列でなく単一オブジェクト**（静的の `media[]` は誤り）。`keys[]` は per-recipient。`permission` は **`allow_saving`**。
- カレンダー `collection/{id}/messageDaysInMonth` → `{success, collectionId, year, month, timeZone, days:[…]}`（**件数は返らない**）。
- 動画 CDN は**無認証 GET 200**、`application/octet-stream`（E2EE 暗号文）、**約 1.43MB / 2 秒 720p**、`accept-ranges: bytes`（**Range 206 対応**）、etag あり。
- 付随：`GET recent` / `GET auth/key-backup` / `POST auth/updatePublicKey` / `GET chat/message/participantKeys` / `GET chat/keyRequests` / `POST chat/message/updateReadTimestamp`。`POST auth/diagnostics` は **404**。
- NSC：インストール済みビルドは user CA 非信頼（`system` ＋ `@raw/amazon_root_ca_1`、ピンニングなし）。傍受には `src="user"` を足した再パッチが必要だった。

## 1. バックエンドの種類

| 項目 | 結果 | 状態 |
| --- | --- | --- |
| ベース URL | `https://api.newchatapi.com/`（AWS API Gateway prod。障害時は execute-api 直 URL へ） | 静的 |
| 種類 | 独自 REST（JSON over HTTPS）。ページングは DynamoDB 形式の `lastEvaluatedKey` | 静的 |
| メディア配信 | `https://media.newchatapi.com/<path>`（中身は E2EE 暗号文。第 4.6 / 4.7 節） | 静的 |
| Firebase | FCM（プッシュ）専用。Firestore / Auth / Storage は不使用。Supabase 等もなし | 静的 |
| App Check / Play Integrity | なし | 静的 |
| SSL pinning | なし。ただし `network_security_config.xml` がユーザー CA を信頼しない（覗くには `src="user"` 追加パッチが必要） | 静的 |
| HTTP クライアント | OkHttp 4.12.0（難読化）＋独自ラッパー | 静的 |

## 2. 認証

| 項目 | 結果 | 状態 |
| --- | --- | --- |
| ログイン方式 | メール OTP（`auth/email/login/start`→`/verify`）、Google、パスキー。電話番号 SMS はなし | 静的 |
| トークンの形式 | ログイン応答の `user.token`。`jwt-key` ヘッダーで送る。JWT か不透明かは未判別 | 静的 |
| 有効期限 | **JWT に `exp` なし**。`GET user/profile` は `token` を返さず**ローテーションしない** → 実質長期有効（失効はサーバー側判定のみ） | 動的 |
| トークンの中身 | **HS256 JWT、payload は `{userId, iat}` のみ**（`decode_token.py` で確認） | 動的 |
| リフレッシュトークン | 存在しない。失効時はメール OTP をやり直す経路になる | 静的 |
| 端末紐付け | ヘッダーとしてはなし。ただし E2EE の端末鍵が AndroidKeyStore に固定されるため、動画の復号は実質端末依存 | 静的 |
| BFF からログインを再現できるか | **メール OTP は再現可能を実測**（`start`→`verify` を curl で 200、`verify` 応答に `token`）。bot 対策・レート制限は今回は未発火。Google／パスキーは端末必須 | 動的 |

## 3. 必須ヘッダー

ヘッダーを1つずつ外して再送し、結果を記録する（設計書 第4章 手順4）。

`GET /collections` で各ヘッダーを 1 つずつ外して実測（curl、トークンはログイン直後の有効なもの）。

| ヘッダー | 値の形（伏せ字） | 外したときの結果 | 必須か |
| --- | --- | --- | --- |
| `jwt-key` | `<token>`（`Bearer` なし、169 文字の JWT） | **401** | **必須（動的）** |
| `x-api-key` | 40 文字の固定値 | **200（通る）** | **`/collections` では不要（動的）**。login 等の事前認証 API では必要な可能性があり安全のため送る |
| `Content-Type` | `application/json` | 200 | GET では不要（動的） |
| `User-Agent` | `okhttp/4.12.0`（既定） | 任意値でも 200 | UA 検査なし（動的） |
| 署名・タイムスタンプ系 | なし | — | なし（静的） |

**結論（動的）：必須は `jwt-key` のみ。** 署名・端末証明がないため、`jwt-key`（＋念のため `x-api-key`）だけで BFF から叩ける。これで方式 A が成立。

## 4. 操作ごとの仕様

各操作で共通の書式：

- **リクエスト**：メソッド、パス、クエリ、ボディ
- **レスポンス**：主要フィールドと型（zod スキーマ名）
- **フィクスチャ**：`fixtures/` のファイル名
- **メモ**：ページング、タイムゾーン、エラー時の形など

レスポンスの JSON 例とモデルクラスは [static-analysis.md 第 4 節](static-analysis.md) にある。ここは各操作のエンドポイントと確認すべき点のみ。

### 4.1 ログイン

- リクエスト：`POST auth/email/login/start` `{email, language}` → `POST auth/email/login/verify` `{email, code, language}`（どちらも 200 を実測）
- レスポンス：`{ "user": { userId, name, lastName, pin, avatarUrl, region, publicKey, kid, backupEmail…, hasKeyBackup, language, timezone, deviceToken, token } }`。`token` が入る
- フィクスチャ：[`auth.login.json`](../fixtures/auth.login.json)
- メモ：状態＝動的。bot 対策・レート制限・IP 制限は今回は未発火（短時間に数回で止まらず）。`needs_onboarding` 等の分岐は未取得

### 4.2 トークン更新

- リクエスト：`GET user/profile`（パラメータなし）
- レスポンス：`{ "user": { … } }`。**`token` は入らない**（実測）
- フィクスチャ：[`user.profile.json`](../fixtures/user.profile.json)
- メモ：状態＝動的。**`token` を返さない＝ローテーションしない**。JWT に `exp` も無いので実質無期限。失効時はメール OTP やり直し

### 4.3 グループ一覧

- リクエスト：`GET collections`（`?lastEvaluatedKey=<opaque>` でページング。今回は `lastEvaluatedKey` が null）
- レスポンス：`{ "success", "collections": [ { id, name, pin, type, creatorId, createdTimestamp, updatedTimestamp, maxParticipants, participants[{userId,name,lastName,avatarUrl,tintColor,language,timezone,region,publicKey,kid}], lastReadTimestamp, roomType, roomLocked, memberProfiles{} } ], "lastEvaluatedKey" }`
- フィクスチャ：[`groups.list.json`](../fixtures/groups.list.json)
- メモ：状態＝動的。**ソロログはここに含まれる**（`type=collection`, `roomType=log`/`vlog`, participants 0〜1）。**DM は混ざらず、別経路 `GET chat/conversations`**。`roomType` は `log`/`vlog` を観測（`stack` は未観測）

### 4.4 日付ごとの投稿（24 枠のクリップ一覧）

- リクエスト：2 形式が通る（実測）。**日レンジ**：`GET chat/{collectionId}/messages?startTimeInterval=<ms>&endTimeInterval=<ms>`（`start` は現地 04:00 起点、`end` は +86,400,000。200）。**アプリ既定（フィード）**：`GET chat/{collectionId}/messages?limit=40&beforeTimestamp=<ms>`
- レスポンス：`{ "success", "messages": [ { messageId, conversationId, senderId, parentId, senderName, message, contentType, envelope, keys[], media, reactions[], readBy[], savedBy[], timestamp, isDeleted, type } ] }`
- **重要差分**：`media` は**配列でなく単一オブジェクト** `{ captions[{style,text,time,translation}], captureCountryCode, captureUTCOffsetSeconds, dimensions{width,height}, mimeType, path, permission, region }`。静的の `media[]` / `mediaCipherV` / `hasMore` / `nextSinceTimestamp` は今回のレスポンスには無い
- `keys[]`：per-recipient の `{ alg, kid, saltB64, senderKid, senderPublicKey, uid, v, wrappedB64 }`（自分宛は `uid == 自分の userId`）
- フィクスチャ：[`days.past.json`](../fixtures/days.past.json)（クリップ 1 件）/ [`days.today.json`](../fixtures/days.today.json)（空の日 `messages:[]`）
- メモ：状態＝動的。**時間枠（hour）は API が返さない**（`timestamp` から 04:00 起点で算出）。未投稿枠は欠落するのでクライアントで 24 枠を埋める

### 4.5 カレンダー

- リクエスト：`GET collection/{collectionId}/messageDaysInMonth?year=YYYY&month=M&timeZone=Asia/Tokyo`（**単数形 `collection/`**、`month` は 1-12。200 を実測）
- レスポンス：`{ "success", "collectionId", "year", "month", "timeZone", "days": [3, 4, …] }`（投稿がある日の整数配列**のみ。件数は返らない**）
- フィクスチャ：[`calendar.month.json`](../fixtures/calendar.month.json)
- メモ：状態＝動的。月単位のみ。濃淡表示に件数が要るなら日別 API を叩いて数えるか、二値表示にする

### 4.6 動画取得

- リクエスト：4.4 の `media.path` を使い `GET https://media.newchatapi.com/<path>`（`path` の形は `ap/uploads/{senderId}/{timestamp}-{hash}`）。**認証ヘッダー不要で 200**（実測）。中身は**暗号文**
- 復号：`keys[]` の自分宛（`uid == 自分の userId`）の項目から content key を開き、ChaCha20-Poly1305 で復号（第 4.7 節）
- フィクスチャ：[`clips.media.json`](../fixtures/clips.media.json)（暗号文本体はコミットしない。`media` メタと CDN ヘッダー実測値のみ）
- メモ：下表。**暗号文なので `<video src>` に直接渡しても再生できない**

| 項目 | 結果 | 状態 |
| --- | --- | --- |
| 形式 | `media.mimeType = video/mp4`。CDN は `content-type: application/octet-stream`（暗号文）。HLS なし | 動的 |
| URL の種類 | **署名なし・認証ヘッダー不要で 200**。中身は E2EE 暗号文 | 動的 |
| 署名付き URL の有効期限 | 該当なし（署名なし） | 動的 |
| `Range` 対応 | **`accept-ranges: bytes`、`Range: bytes=0-1023` → 206**。ただしストリーム暗号で部分復号は実用性低 | 動的 |
| 1 本あたりのサイズ | **1,434,389 B ≒ 1.43 MB**（約 2 秒 / 720p の自分のクリップ 1 本） | 動的 |
| 解像度 | `media.dimensions = {width:1280, height:720}`。`permission = allow_saving` | 動的 |
| その他ヘッダー | `etag` あり。`content-length` あり | 動的 |
| サムネイル | API になし。クライアントが動画から生成してキャッシュ | 静的 |

### 4.7 暗号化（E2EE）— 方式判定の根拠

- 鍵交換 X25519 ＋ HKDF-SHA256、本体 ChaCha20-Poly1305。詳細な info 文字列・ブロック構造は [static-analysis.md 第 4.7 節](static-analysis.md)
- **X25519 秘密鍵は AndroidKeyStore（`setlog.identity.master`、AES-256-GCM、エクスポート不可）で保護**。サーバーも BFF も単独では復号できない
- 復号に必要なのは (a) 端末内の秘密鍵、または (b) 鍵バックアップのパスフレーズ（PBKDF2-HMAC-SHA256 60 万回）
- 帰結：動画は方式 A（BFF 中継）では取れない。A′（端末で復号してアップロード）が必要

### 4.8 テキストチャット（受信・送信）

動的解析で確定（2026-11-18、実 API で送受信を検証）。

- **会話一覧**：`GET chat/conversations` → `{success, conversations[], lastEvaluatedKey}`（DM。collection とは別）
- **参加者の鍵**：`GET chat/message/participantKeys?conversationId={id}` → `{success, participants[{userId, name, publicKey, kid, …}]}`（送信時の鍵ラップに使う。旧アカウントでは自分も含まれたが、2026-11-19 の今のアカウントでは**自分を含まなかった**。自分の `kid`・`publicKey` は `GET user/profile` から取る）
- **メッセージ取得**：`GET chat/{conversationId}/messages?limit=40[&beforeTimestamp=<ms>]`。テキストは `contentType="text/plain"` で `envelope` を持ち `media` は無い
- **送信**：`POST chat/{conversationId}/message`（単数 `message`）
  ```json
  { "type": "chat", "conversationId": "<id>", "messageId": "<uuid>", "uuid": "<uuid>",
    "refreshesStaleKeys": true, "contentType": "text/plain",
    "keys": [ { uid, kid, v, alg, saltB64, wrappedB64, senderKid, senderPublicKey } ],
    "envelope": { v, alg: "CHACHA20-POLY1305", aadB64, combinedB64 } }
  ```
  応答：`{ success, messageId }`（200）
  - **返信**：本文に `"parentId": "<返信先の messageId>"` を足す（静的：`gf1.java:44-51`。空なら入れない）。会話画面での返信は `type: "chat"`・今の会話宛で、`parentId` に返信先の `messageId` を入れる（`j5.java:979`）。暗号の AAD（下記の content info）には入らない。動的には未確認（キャプチャに返信の実例が無い）
- **暗号**：content key（ランダム32B）でテキストを ChaCha20-Poly1305 で封入し `envelope` に。`aadB64` は content info（`msg:enc:v1|conv:{convId}|msg:{msgId}|sender:{senderId}|type:text/plain`）の base64。content key を各参加者の公開鍵宛に X25519→HKDF→ChaCha20-Poly1305 でラップし `keys[]` に。実装は `lib/setlog/crypto.ts`（`encryptText`/`decryptText`）
- フィクスチャ：実データにトークン/本文が絡むためコミットしない（`captures/` のみ）

### 4.9 WebSocket（リアルタイム受信）

静的解析（2026-11-18、`of1`/`n3`/`pl6`/`wh1`/`xi1` ほか。根拠は下記）と、Node から直接接続した実測（2026-11-18）で確認。

- **接続**：`wss://ws.newchatapi.com/`、ヘッダーは `jwt-key` のみ（`x-api-key` 不要）、クエリなし。permessage-deflate なしでも接続できる（実測）。**スマホのアプリと同じトークンで 2 本目の接続を張っても弾かれない**（実測）
- **購読は不要**：接続後に送るべきフレームは無い。クライアントが送る action は `typing` だけ（`wh1.java:74-110`）。接続するだけで、参加している会話・コレクションのイベントが届く（実測）
- **ハートビート**：サーバーから 30 秒ごとに ping（WebSocket の制御フレーム）。ライブラリが pong を返せばよい。`ws` パッケージの `ping` イベントで 30 秒ごとに受け取れることを確認した（実測 2026-11-19、100 秒で 3 回）
- **受信形式**：`{"action": "...", "data": {...}}`。主な action（`pl6.java:1531-1630`）：

  | action | 中身 | 状態 |
  | --- | --- | --- |
  | `newMessage` | メッセージ本体。REST の messages と同じ形（`conversationId`/`messageId`/`senderId`/`messageType`/`type`/`timestamp`/`keys[]`/`contentType`、テキストは `envelope`、クリップは `media`） | 動的 |
  | `messageUpdate` / `messageDeleted` | 編集（キャプション）／削除（`messageId`, `conversationId`） | 静的 |
  | `newReaction` / `reactionRemoved` / `readReceipt` / `typing` | リアクション・既読・入力中 | 静的 |
  | `newCollection` / `collectionJoined` / `collectionLeft` / `newConversation` 系 | 参加グループの変化（ID のみ） | 静的 |

- **写真**（実測 2026-11-19）：`type=snap`、`contentType=image/jpeg`、`envelope=null`、`media` はクリップと同じ形（`mimeType=image/jpeg`、720×1280）。`keys[]` の自分宛エントリで content key を開き、`decryptMedia`（AAD の MIME は `image/jpeg`）で JPEG に戻る
- **テキストとクリップは同じ `newMessage` で届く**（実測）。テキストは `type=chat`・`contentType=text/plain`、クリップは `type=collection`・`contentType=video/mp4`。今回のグループでは両者の `conversationId` が同じ値だった
- **本体がそのまま載る**（実測）：他人のテキストは `decryptText` で復号でき、他人のクリップは `media.path` を CDN から取得して `decryptMedia` で mp4（1280×720、約 1.47MB）まで復号できた。`keys[]` は**自分宛の 1 件だけ**入っていた。撮影の `timestamp` から受信まで約 9 秒
- **再送は無い**（静的・推測）：アプリは再接続のたびに REST で取り直している（`xi1.b`→`xi1.g`）。取りこぼしは `GET chat/{id}/messages` で埋める必要がある
- **補完に使う REST の範囲**（実測 2026-11-18）：`GET chat/{id}/messages?limit=40` を**パラメータなしで叩くと当日分（11/18 の 4 件）しか返らなかった**（範囲の正確な定義は未確認）。`beforeTimestamp=<現在時刻 ms>` を付けると日付をまたいで新しい順に `limit` 件返る（`limit=5` で 5 件）。`beforeTimestamp` はその時刻ちょうどのメッセージも含んだ。`lastEvaluatedKey` は今回いつも null
- **再接続**：アプリは `min(60s, 1s << min(n-1, 5))` のバックオフ（1→32 秒で頭打ち）。**close code `4403` はアカウントロック扱いで、再接続しない**（`n3.java` の `h()`、`of1.java:232-233`）
- **自分の発言は自分の接続に流れない**（実測）：待ち受け中（13:50:03 接続）に自分がスマホから送ったテキスト（サーバー上の `timestamp` は 13:53:39）は、同じアカウントの別接続に届かなかった。REST の `GET chat/{id}/messages` には入っている。自分の発言・自分のクリップを拾うには REST が必要
- **新着は同じアカウントの「最後に接続した 1 本」にだけ届く**（実測 2026-11-19）：Bot（01:49:46 に接続）には 01:49:59・01:51:36 の友達のテキストがリアルタイムで届き、その前（01:47:14）に張った記録用の接続には届かなかった。01:35 に 2 本張った確認では後の 1 本にも届かなかったが、その間にスマホのアプリがつなぎ直したと見れば合う。API Gateway の WebSocket で接続のたびに配信先を上書きする作りと見られる。配信先から外れた接続は切られず、ping も届き続けるので、クライアントからはその場で気づけない（close も通知も無い）。スマホでアプリを開くとアプリが配信先になり、Bot がつなぎ直すと Bot に戻る。REST には入っている
- **15 分間の接続はサーバーから切られなかった**（実測。こちらから close 1000 で閉じた）
- **トークンが不正なら接続時に HTTP 401**（実測。curl で Upgrade を送ると 401）。Node 組み込みの `WebSocket` では close 1006 しか見えず 401 と通信断を区別できない。ping も受け取れない。Bot では `ws` パッケージを使う（`unexpected-response` で状態コード、`ping` イベントで生存確認）
- **未確認**：`messageUpdate` などの実際の形、それより長い接続の安定性

## 5. 判定

| 判定項目 | 結果 |
| --- | --- |
| Web SDK から直接読めるか（C の条件） | 不可。Firebase は FCM 専用、データは独自 REST |
| BFF から直接呼べるか（A の条件） | メタデータは可（`x-api-key` 固定・署名なし・`jwt-key` でアクセス）。動画は不可（E2EE、鍵は端末内） |
| 端末でしか取得できないか（A′ の条件） | 動画のみ A′ 必須。テキスト・メタデータは A で足りる |
| **採用方式** | **A ＋ A′ のハイブリッド**（メタデータは BFF 中継、動画は cutlog から復号アップロード） |
| 判定理由 | 認証はメール OTP で再現可能の見込みで端末証明なし。動画は AndroidKeyStore 保護の X25519 鍵でしか復号できない。よって「BFF がメタデータ、cutlog が端末で復号した mp4 をアップロード」が最小構成 |

> **動的解析（2026-11-18）で確定。** `jwt-key` だけで `/collections` が 200（`x-api-key` すら不要）、メール OTP の `start`→`verify` を curl で再現し `token` を取得、さらに `collections` / `messageDaysInMonth` / `messages`（日レンジ）/ 動画 CDN を BFF 相当の curl で取得できた。動画のみ E2EE で方式 A′ が必要、という判定は変わらない。

## 6. 設計書への反映が必要な点

[static-analysis.md 第 6 節](static-analysis.md) に 9 件。主なもの：

1. 日の境界が 0 時ではなく**現地 04:00**。設計書 7 章の `date` / `hour` 定義を直す
2. `hour` は API が返さない。`capturedAt` から 04:00 起点で計算（7 章の「API が返すなら優先」は不要）
3. 認証ヘッダーは `jwt-key`。`Authorization: Bearer` ではない（5・6 章）
4. リフレッシュトークンなし。5 章の「期限前／401 でリフレッシュ」は不成立。失効時はメール OTP やり直し
5. 動画は E2EE で方式 A では取れない。3 章の方式表に A＋A′、8 章の「署名付き URL 302」は不成立と明記
6. カレンダーは件数を返せない（6 章キャッシュ表・10 章の濃淡表示）
7. サムネイル API なし。6 章の `/thumb` は端末生成アップロードか `<video preload>` 代替に
8. グループの内部名は `collection`。`/api/groups` は `GET /collections`
9. SSL ピンニングは無いが `network_security_config` がユーザー CA を拒否。4 章パッチに `<certificates src="user"/>` 追加を明記
