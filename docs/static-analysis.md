# setlog 静的解析レポート（jadx 逆コンパイル結果）

- 解析対象：`com.newchat.setlog` v1.3 / versionCode 76（`resources/AndroidManifest.xml:2-4`）
- 解析日：2026-11-18
- 対象ディレクトリ：`/Users/uta_a/Projects/cutlog/setlog-apk/jadx-out`（読み取りのみ、変更なし）
- 表記：**【確認】** = コード/リソースに直接書かれていた事実。**【推測】** = 周辺コードからの推定で、動的解析で確定させる必要があるもの。**見つからない** = 該当する記述・コードが存在しなかった。

`docs/api.md` の章立てに合わせている。値はすべて先頭 6 文字だけ残して伏せてある。

---

## 0. 前提：難読化の状況

| 項目 | 結果 | 根拠 |
| --- | --- | --- |
| クラス名 | `defpackage` 配下に 6,979 ファイル。全て 1〜3 文字の識別子（`a` / `a0` / `uh2` / `th2` / `xs9`）にリネーム済み | `sources/defpackage/` |
| リネームされていない部分 | エントリポイントと View のみ（`com.newchat.setlog.*` 48 ファイル） | `sources/com/newchat/setlog/` |
| 文字列定数 | **難読化されていない**。URL パス・JSON キーがそのまま残る | 全編 |
| ライブラリ | OkHttp も `defpackage` に吸収済み（`okhttp3/` には `PublicSuffixDatabase` だけ残る） | `sources/okhttp3/internal/publicsuffix/` |
| R8 マップ ID | `r8-map-id-bc76fce7…` で全クラス共通 | 各 `.java` の先頭コメント |
| クラス融合 | 無関係なクラスが 1 ファイルに融合している（例：`fm.java` にコレクション API と CameraX が同居、`bw0.java` は 16 個のコンストラクタを持つ） | `sources/defpackage/bw0.java` |
| アプリ保護 | Google PairIP（`com.pairip.application.Application`）と Play ライセンス確認（`com/pairip/licensecheck/*`）が入る。**API 認証とは無関係**（API クライアントから参照なし） | `resources/AndroidManifest.xml:46`, `sources/com/pairip/licensecheck/LicenseClient.java` |

**読み方の指針**：クラス名は全て無意味なので、以降は「役割名（難読化クラス名）」の形で書く。JSON キーと URL パスは平文なので、そこから逆引きできる。

---

## 1. バックエンドの種類

| 項目 | 結果 | 根拠 |
| --- | --- | --- |
| ベース URL | `https://api.newchatapi.com/` | `sources/defpackage/uh2.java:32`（`tk2Var.d(null, "https://api.newchatapi.com/")`） |
| 種類 | **独自 REST（JSON over HTTPS）**。Retrofit / Ktor / GraphQL / Apollo は不使用 | 下記「HTTP クライアント」参照。GraphQL の痕跡（`/graphql`、`query {`）は見つからない |
| 実体 | AWS API Gateway（`prod` ステージ）＋カスタムドメイン。API Gateway 直 URL は `https://j6x2txqgbb.execute-api.us-east-1.amazonaws.com/prod/`、`https://nn7gszlmp3.execute-api.ap-northeast-2.amazonaws.com/prod/` | `sources/defpackage/th2.java:277,470,746,1029` |
| リージョン分岐 | メディアの **アップロード URL 発行だけ** `ap-northeast-2` なら `https://api-kr.newchatapi.com/media`、それ以外は `https://api.newchatapi.com/media` | `sources/defpackage/s93.java:27` |
| メディア配信 | `https://media.newchatapi.com/<path>`（CDN） | `sources/defpackage/c24.java:32` |
| リアルタイム | WebSocket `wss://ws.newchatapi.com/`（`permessage-deflate`） | `sources/defpackage/of1.java:65`, `sources/defpackage/ll3.java:252-256` |
| ページング | DynamoDB 形式。`lastEvaluatedKey` をクエリで渡す | `sources/defpackage/dd1.java:71,92`, `sources/defpackage/mx3.java:1141` |
| HTTP クライアント | **OkHttp 4.12.0**（`defpackage` に難読化。`User-Agent: okhttp/4.12.0` を自前で付ける処理あり）＋ 独自ラッパー（ログタグ `HaiRequest` / `HaiSocket`） | `sources/defpackage/fv.java:85-86`, `sources/defpackage/uh2.java:158` |
| タイムアウト | connect 30s、write/read/call 30s（通常）と 180s（大容量用）の 2 種 | `sources/defpackage/sk0.java:48-59`, `sources/defpackage/uh2.java:38-39` |
| リトライ | 最大 3 回。`429/500/502/503/504` とソケット例外で再送。待機 `1000 << n` ms、`Retry-After` を尊重 | `sources/defpackage/th2.java:912-940` |
| リージョン・フェイルオーバー | `api.newchatapi.com` 失敗時に API Gateway 直 URL へ切り替え。`/media/` 配下はパスを `/prod/media/` に付け替え | `sources/defpackage/th2.java:273-300,860-900` |

### Firebase（`resources/res/values/strings.xml`）

| キー | 値 | 用途 |
| --- | --- | --- |
| `google_app_id` | `1:7523***` | 【確認】FCM 用 |
| `project_id` | `setlog-59be9` | 【確認】FCM 用 |
| `gcm_defaultSenderId` | `752373184703` | 【確認】FCM 用 |
| `google_api_key` | `AIzaSy***` | 【確認】FirebaseOptions 経由（`sources/defpackage/w32.java:36`） |
| `google_storage_bucket` | `setlog-59be9.firebasestorage.app` | 【確認】値のみ存在 |
| `firebase_database_url` | **存在しない** | `strings.xml` に該当エントリなし |
| `default_web_client_id` | **存在しない**（代わりに `auth_google_server_client_id` = `752373184703-45o627***`） | `resources/res/values/strings.xml:74` |

**結論：Firebase は FCM（プッシュ）専用。** Firestore / Realtime Database / Firebase Auth / Firebase Storage は不採用。

- `resources/AndroidManifest.xml:200-229` に登録された Firebase コンポーネントは `messaging` / `installations` / `datatransport`（Analytics 用）のみ。
- `com.google.firebase.storage` / `com.google.firebase.auth` / `com.google.firebase.firestore` のクラスは 1 つも存在しない。
- Supabase / AWS Amplify / Cognito / AppSync の痕跡は**見つからない**。

### App Check / Play Integrity / SafetyNet / 証明書ピンニング

| 項目 | 結果 | 根拠 |
| --- | --- | --- |
| Firebase App Check | **なし** | `AppCheck` を含むクラスは `fc6.java` のみで、中身は `AppCheckResult{appCheckEnabled=false, appCheckToken=null}` という定数（Google Places SDK の内部型）。App Check のプロバイダ登録なし |
| Play Integrity / SafetyNet | **なし** | `IntegrityManager` / `SafetyNet` / `IntegrityTokenRequest` の参照は見つからない。`attestation` の出現はすべて WebAuthn（パスキー）の用語 |
| CertificatePinner | **なし** | API クライアントは `sk0.k(long)` でタイムアウトのみ設定（`sources/defpackage/sk0.java:48-59`）。`CertificatePinner` を設定している箇所なし。`ky3.java:352` の `sha256/` は OkHttp のエラーメッセージ組み立てだけ |
| network_security_config | **あり**。平文 HTTP 全面禁止＋`amazonaws.com` にだけ独自ルート CA を追加信頼 | `resources/res/xml/network_security_config.xml` |

```xml
<base-config cleartextTrafficPermitted="false">
    <trust-anchors><certificates src="system"/></trust-anchors>
</base-config>
<domain-config cleartextTrafficPermitted="false">
    <domain includeSubdomains="true">newchatapi.com</domain>
    <domain includeSubdomains="true">amazonaws.com</domain>
    <trust-anchors>
        <certificates src="system"/>
        <certificates src="@raw/amazon_root_ca_1"/>
    </trust-anchors>
</domain-config>
```

**mitmproxy のための注意**：ユーザー CA を信頼する設定（`<certificates src="user"/>`）が無いため、SSL ピンニングを外すだけでは通信は見えない。`base-config` / `domain-config` に `src="user"` を足すパッチが必要（設計書 4 章の「Morphe パッチ」に含める）。

---

## 2. 認証

### 2.1 ログイン方式

3 系統ある（実装クラス：認証リポジトリ `tc1`）。

| 方式 | エンドポイント | 備考 |
| --- | --- | --- |
| **メール OTP** | `POST auth/email/login/start` → `POST auth/email/login/verify` | `sources/defpackage/tc1.java:652`, `:2020` |
| Google サインイン | `POST auth/loginWithGoogle`（Google の ID トークンを交換） | `sources/defpackage/tc1.java:427` |
| パスキー（WebAuthn） | `POST auth/verifyAuthenticationResponse`（登録は `auth/generateRegistrationOptions` → `auth/verifyRegistrationResponse`） | `sources/defpackage/tc1.java:1891`, `:374`, `:80` |
| 予備メール | `POST auth/backup-email/login/start` → `/login/verify` | `sources/defpackage/tc1.java:616`, `:1985` |
| 電話番号 SMS | **見つからない** | `sms` 関連の API パスなし |

メールログインのペイロード（`sources/defpackage/pl6.java:1173-1183`）：

```json
// POST auth/email/login/start
{ "email": "...", "language": "ja" }

// POST auth/email/login/verify
{ "email": "...", "code": "123456", "language": "ja" }

// レスポンス（成功時）
{ "user": { "...": "...", "token": "<setlog トークン>" } }
```

`user` が無い場合は `{ "status": "needs_onboarding", "email": "...", "signupToken": "..." }` が返り、`POST auth/email/signup/complete` に進む（`sources/defpackage/tc1.java:2001-2060`）。新規登録時は `publicKey`（X25519 公開鍵）を一緒に送る。

Google ログインのペイロード（`sources/defpackage/tc1.java:405-420`）：

```json
{ "idToken": "<Google ID token>", "googleUserId": "...", "nonce": "...",
  "name": "...", "lastName": "...", "region": "JP", "language": "ja",
  "timezone": "Asia/Tokyo", "publicKey": "<X25519 公開鍵 base64>",
  "avatarUrl": "...", "email": "..." }
```

### 2.2 トークン

| 項目 | 結果 | 根拠 |
| --- | --- | --- |
| 形式 | **不明（JWT か不透明トークンか判別不能）**。ヘッダー名が `jwt-key` なので JWT の可能性が高いが、アプリ内でデコードしている箇所は無い | `sources/defpackage/uh2.java:347`。`exp` をデコードしているのは Google ID token のみ（`sources/defpackage/jc4.java:80-85`） |
| 取得元 | ログインレスポンスの `user.token` | `sources/defpackage/tc1.java:448-452` |
| 保存先 | `SharedPreferences` ファイル **`setlog.session`**、キー **`current_user`**（ユーザー JSON 全体を平文保存） | `sources/defpackage/jd4.java:31,35,64-72` |
| 保存形式 | `{userId, name, lastName, avatarUrl, publicKey, kid, pin, token, deviceToken, region, language, timezone, backupEmail, …, conversations:{}}` の JSON | `sources/defpackage/zx4.java:138-219` |
| 有効期限 | **コード上に存在しない**（期限チェック・`exp` 比較なし） | — |
| リフレッシュトークン | **存在しない** | `refreshToken` の出現は Firebase Installations と Google Maps のみ |
| 更新方法 | **`GET user/profile` を叩き直す**。レスポンスに `user.token` が入っていれば差し替え、無ければ既存を維持 | `sources/defpackage/tc1.java:293-347`（`e()`）と `:443-485`（`h()`：`z ? jd4.a() : null` で既存トークンをフォールバック） |
| 起動時の復元 | **確認できなかった**。アプリ起動時に `GET user/profile` を叩く経路は見つからない。保存済み `current_user` をそのまま信頼して使い、API が 401 を返した時点で初めて失敗が表面化する作りに見える【推測】 | `sources/defpackage/jd4.java:31-48`（起動時はキャッシュ読み出しのみ） |
| 失効時の挙動 | **401 の特別扱いは無い**（リトライも再ログインもしない。例外として呼び出し元へ伝播）。403 かつ `code=account_locked` のときだけ、グローバルな「アカウントロック」状態に遷移する（サインアウトはしない） | `sources/defpackage/uh2.java:158-166`（`i2 == 403 && "account_locked"` → `b4.report(token)`）, `sources/defpackage/b4.java:24-37` |
| 端末紐付け | ヘッダーとしては**無い**。ただし E2EE の端末鍵（後述）が端末に固定されるため、実質的に端末依存 | 3 章・4.7 参照 |
| ログアウト | `DELETE user/removeNotificationToken` を**旧トークン明示**で呼んでから、`current_user` を削除・WebSocket 切断・メディアキャッシュ消去。この 1 本だけ `jwt-key` ではなく `str3` 引数で旧トークンを渡す例外 | `sources/defpackage/tc1.java:123-211`（`b()`）, `sources/defpackage/vb1.java:63-90` |

### 2.3 Authorization ヘッダーを付けるインターウィセプタ

OkHttp の `Interceptor` / `Authenticator` は**使っていない**。代わりに、リクエスト組み立て時に毎回ヘッダーを直接付ける（`sources/defpackage/uh2.java:339-349`）：

```java
if (str3 == null) str3 = this.a.a();   // jd4.a() → 保存済み token
if (str3 != null && !str3.isBlank()) iy2Var.v("jwt-key", str3);
```

つまり **`jwt-key: <token>`（`Bearer ` 接頭辞なし）** が実質の `Authorization`。

### 2.4 BFF からログインを再現できるか

- **メール OTP 方式なら再現可能**【推測】：`auth/email/login/start` にメールアドレスを投げればよい。メールボックスを自分で読めるので OTP を取得できる。ただし以下が不明：
  - `auth/email/login/start` をブラウザ/Workers から叩いたときに追加の bot 対策（reCAPTCHA 等）があるか → コード上は**見つからない**（`recaptcha` / `hcaptcha` の参照ゼロ）。ただしサーバー側の判定は静的解析では分からない
  - 新規端末としてログインした場合、E2EE の鍵が無いので**過去のメディアは復号できない**（4.7 参照）。既存端末の鍵バックアップが必要
- Google サインインは ID トークンが必要で、BFF からの再現は非現実的。
- パスキーは端末必須。

---

## 3. 必須ヘッダー

アプリが付けるヘッダーは **3 つだけ**（`sources/defpackage/uh2.java:334-349`）。

| ヘッダー | 値の形（伏せ字） | 付与条件 | 必須か |
| --- | --- | --- | --- |
| `Content-Type` | `application/json` | 常に（GET でも付く） | 【推測】必須ではないが付けておく |
| `x-api-key` | `7CApGF***`（40 文字） | 常に。**バイトコードに直書き** | 【推測】必須（API Gateway の API キー） |
| `jwt-key` | `<token>`（`Bearer` なし） | ログイン済みのときのみ。未ログイン API（`auth/*`）では付かない | 【推測】認証必須 API では必須 |
| `User-Agent` | `okhttp/4.12.0` | OkHttp の既定。アプリ独自 UA は**無い** | 【推測】不要 |
| アプリバージョン系 | **ヘッダーとしては存在しない** | — | — |
| 端末 ID 系 | **ヘッダーとしては存在しない** | — | — |
| 署名・タイムスタンプ系 | **存在しない**（HMAC/AWS SigV4 の実装なし） | — | — |
| `Accept-Encoding` | `gzip` | OkHttp の既定 | — |

**署名系ヘッダーは無い。** リクエスト署名・タイムスタンプ・nonce の類は一切実装されていない（`HmacSHA` / `AWS4-HMAC` / `X-Signature` の参照ゼロ）。`x-api-key` は固定値なので、静的解析結果だけで完全再現できる。

アプリバージョンと端末情報は、**ヘッダーではなく `POST auth/diagnostics` のボディ**に入る（`sources/defpackage/y31.java:1224-1236`）：

```json
{ "event": "auth_...", "authAttemptId": "...", "authMethod": "...", "elapsedMs": 123,
  "manufacturer": "...", "brand": "...", "model": "...", "device": "...", "product": "...",
  "androidSdk": 35, "androidRelease": "15",
  "packageName": "com.newchat.setlog", "appVersionName": "1.3", "appVersionCode": 76,
  "googlePlayServicesVersionName": "...", "googlePlayServicesVersionCode": 0,
  "googleApiAvailabilityStatus": 0 }
```

これは任意（テレメトリ）なので BFF では送らなくてよい。

**WebSocket のヘッダー**は `jwt-key` のみで、`x-api-key` は付かない（`sources/defpackage/of1.java:265-269`）。

---

## 4. 操作ごとの仕様

共通事項：

- ベース：`https://api.newchatapi.com/`
- ボディは常に JSON。GET でも `Content-Type: application/json`
- エラー時：HTTP 4xx/5xx ＋ ボディ `{"message"|"error"|"detail": "...", "code": "..."}`（`sources/defpackage/uh2.java:104-155`）
- 成功判定：HTTP 2xx（`sources/defpackage/uh2.java:78`）

### 4.1 ログイン

- **リクエスト**（2 段階）
  1. `POST auth/email/login/start` — `{email, language}`
  2. `POST auth/email/login/verify` — `{email, code, language}`
- **レスポンス**
  ```json
  { "user": { "userId": "...", "name": "...", "lastName": null, "avatarUrl": null,
              "publicKey": "...", "kid": "...", "pin": "...", "token": "<token>",
              "deviceToken": "...", "region": "JP", "language": "ja",
              "timezone": "Asia/Tokyo", "backupEmail": null, "backupEmailVerified": false,
              "backupEmailEnabled": false, "hasKeyBackup": false, "pushFrequency": 0,
              "shouldHideLocalTime": false, "score": 0, "friendRequestsCount": 0,
              "unreadCount": 0, "mutedConversations": [...], "blockedUsers": [...],
              "tintColor": null, "conversations": { "<conversationId>": {"id": "...", "unreadCount": 3} } } }
  ```
- **モデルクラス**：リクエスト `w43`（Map ビルダ）, レスポンス `ec3.y()` → `zx4`（User）
- **根拠**：`sources/defpackage/tc1.java:652`（start）, `:2020-2034`（verify）, `sources/defpackage/ec3.java:279-400`（パーサ）, `sources/defpackage/zx4.java:138-219`（シリアライズ）
- **メモ**：`status: "needs_onboarding"` なら新規登録フロー。OTP は `resendAfterMs` で再送制限。電話番号 SMS は無い。

### 4.2 トークン更新

- **リクエスト**：`GET user/profile`（クエリ・ボディなし）
- **レスポンス**：`{"user": { … 4.1 と同じ形 … }}`。`user.token` が新しいトークン（無ければ既存を継続）
- **モデル**：`ec3.y()` → `zx4`
- **根拠**：`sources/defpackage/tc1.java:320`（リクエスト）, `:488-547`（`j()`：`POST user/profile` に `{backupEmail:""}` を付ける変種もあり）, `:293-347`（`e()`）
- **メモ**：リフレッシュトークンは無い。**トークンが失効したらメール OTP をやり直すしかない**。レスポンスに `token` が含まれるかは動的確認が必要（含まれない実装なら、トークンは無期限）。

### 4.3 グループ一覧

- **リクエスト**：`GET collections`（クエリはページングのみ）
  ```
  GET /collections
  GET /collections?lastEvaluatedKey=<opaque>
  ```
- **レスポンス**
  ```json
  {
    "collections": [
      {
        "id": "<collectionId>",
        "participants": [ { "userId": "...", "name": "...", "lastName": null, "avatarUrl": "...",
                            "publicKey": "...", "kid": "...", "pin": "...", "...": "..." } ],
        "messages": [ /* 最新 1 件が入ることがある */ ],
        "lastestMessage": [ /* サーバー側のtypo。messages が空のときのフォールバック */ ],
        "recentReactions": [ ... ],
        "unreadCount": 0, "unreadDMCount": 0, "unreadMediaCount": 0,
        "unreadUserIdentifiers": ["..."],
        "streakCount": 3, "streakUpdateTimestamp": 0,
        "createdTimestamp": 0, "updatedTimestamp": 0, "lastReadTimestamp": 0,
        "typing": false, "pinned": false, "pinnedAtMs": 0, "pinnedLocation": null,
        "name": "グループ名", "roomImagePath": "media-v2/...", "creatorId": "...",
        "type": "collection",          // "conversation" | "collection"
        "pin": "AB12CD",               // 招待コード
        "maxParticipants": 20,
        "roomType": "vlog",            // "log" | "vlog" | "stack"
        "roomLocked": false,
        "memberProfiles": { "<userId>": { "name": "...", "avatarUrl": "..." } }
      }
    ],
    "lastEvaluatedKey": "<opaque>"
  }
  ```
- **モデル**：`nz0`（Conversation）。パーサは `rd.v()`（`sources/defpackage/rd.java:676-800`）
- **根拠**：`sources/defpackage/dd1.java:76,97`（リクエスト）, `sources/defpackage/fm.java:1296-1345`（`k()`：`collections` を連結してページング）, `sources/defpackage/mx3.java:1141`（`lastEvaluatedKey` で次ページ）
- **メモ**
  - **ソロログがここに含まれるかは未確定**。会話種別は `type`（`conversation` = DM, `collection` = グループ）と `roomType`（`log` / `vlog` / `stack`）の 2 軸（`sources/defpackage/n11.java`, `sources/defpackage/yo0.java`）。自分のソロログは「participants が自分 1 人だけの会話」として返る可能性が高い【推測】→ 動的確認項目。
  - メンバー情報は `participants[]`（フルユーザーオブジェクト）と `memberProfiles{}`（軽量版）の二重持ち。
  - **DM（1 対 1）は `collections` に含まれない**可能性がある。DM 一覧は `user.conversations` の Map から取る設計（`sources/defpackage/zx4.java:288-307`）【推測】。
  - グループ作成は `POST collections` — `{participantUIDs: [...], name: "...", maxParticipants: 20, roomType: "vlog"}`（`sources/defpackage/fm.java:996-999`）。参加は `POST collections/{id}/join`（`sources/defpackage/fm.java:1513`）、招待コードからは `POST collections/collectionFromPin` `{pin}`（`sources/defpackage/fm.java:1369`）。

### 4.4 日付ごとの投稿（24 枠のクリップ一覧）

- **リクエスト**：`GET chat/{collectionId}/messages?startTimeInterval=<ms>&endTimeInterval=<ms>`
  ```
  GET /chat/{id}/messages?startTimeInterval=1730828400000&endTimeInterval=1730914800000
  ```
  - `startTimeInterval` = その「日」の開始 epoch ms
  - `endTimeInterval` = 開始 + 86,400,000
  - **「日」の境界は現地時刻 04:00**（深夜 0 時ではない）
- **レスポンス**
  ```json
  {
    "messages": [
      {
        "messageId": "...", "id": "...", "conversationId": "...",
        "senderId": "...", "senderName": "...",
        "parentId": null,
        "message": null,                       // テキストは暗号化時ここが空
        "contentType": "video/mp4",
        "timestamp": 1730832000123,            // epoch ms
        "location": {"x":0.0,"y":0.0} | null,
        "type": "collection", "messageType": "collection",
        "media": [
          {
            "id": "...", "messageId": "...",
            "path": "media-v2/shared-media/....enc",   // ← これがメディアキー
            "localUri": null,
            "region": "ap-northeast-2",
            "dimensions": {"width": 720.0, "height": 1280.0},
            "mimeType": "video/mp4", "mediaType": "video",
            "fullscreen": true, "isIntro": false, "hasAudio": true,
            "permission": "SAVING",
            "captions": [ {"text":"...","time":"...","translation":{"x":..,"y":..},"style":0} ],
            "captureUTCOffsetSeconds": 32400, "captureCountryCode": "JP"
          }
        ],
        "reactions": [...], "readBy": ["..."], "savedBy": ["..."],
        "isDeleted": false, "isLocal": false,
        "envelope": {"v":1,"alg":"CHACHA20-POLY1305","aadB64":"...","combinedB64":"..."} | null,
        "keys": [
          {"uid":"<受信者userId>","kid":"<鍵ID>","v":1,
           "alg":"X25519-HKDF-SHA256+CHACHA20-POLY1305",
           "saltB64":"...","wrappedB64":"...","senderKid":"...","senderPublicKey":"..."}
        ],
        "mediaCipherV": 2
      }
    ],
    "hasMore": false,
    "nextSinceTimestamp": 1730832000123
  }
  ```
- **モデル**：`mc3`（Message）, `oc3`（Media）。パーサは `s43.i()`（`sources/defpackage/s43.java:41-176`、`replies` を含む展開は `s43.l()` `:178-237`）、`px5.l()`（`sources/defpackage/px5.java:1117-1290`）、配列は `hp3.c()`（`sources/defpackage/hp3.java:670-700`）
- **根拠**：`sources/defpackage/wh1.java:1258-1290`（`q()`: GET、日境界の計算）, `sources/defpackage/wh1.java:1300-1330`（`messages[]` の取り出し）
- **メモ**
  - **時間枠（0-23）は API が返さない。** `timestamp` から計算する。日境界が 04:00 なので `hour = ((timestamp - dayStart) / 3600000)` の 0-23 になる。設計書 7 章の `hour: 0–23` はこの定義に合わせる必要がある。
  - タイムゾーンは **端末の `ZoneId.systemDefault()`** を使う（`sources/defpackage/wh1.java:1281`）。サーバーにタイムゾーンを送っていない。BFF では `Asia/Tokyo` を明示的に使えばよいが、アプリの出力と一致させるにはデバイス設定が Asia/Tokyo である必要がある。
  - ページング：同じエンドポイントに `?sinceTimestamp=<ms>&sinceId=<id>` を付けて繰り返す。`hasMore` が false か `nextSinceTimestamp` が進まなくなるまで（`sources/defpackage/wh1.java:1116-1200`）。
  - 履歴の逆方向取得：`GET chat/{id}/messages?limit=N&beforeTimestamp=<ms>` または `?limit=N&cursor=<opaque>`（`sources/defpackage/wh1.java:1401-1412`）。
  - 1 メッセージ取得：`GET chat/message/{messageId}?conversationId=<id>` → `{"message": {...}}`（`sources/defpackage/wh1.java:1351`）。
  - 既読：`POST chat/message/updateReadTimestamp` `{conversationId, conversationType: "collection"|"chat", readTimestamp}`（`sources/defpackage/wh1.java:1487`）。
  - 空枠（未投稿）は `messages[]` に存在しない。クライアント側で 24 枠を埋める。

### 4.5 カレンダー

- **リクエスト**：`GET collection/{collectionId}/messageDaysInMonth?year=YYYY&month=M&timeZone=Asia/Tokyo`
  ```
  GET /collection/{id}/messageDaysInMonth?year=2026&month=11
  GET /collection/{id}/messageDaysInMonth?year=2026&month=11&timeZone=Asia%2FTokyo
  ```
  - **注意：単数形 `collection/`**（一覧は `collections`）。実装の揺れ。
  - `year` / `month` は**文字列**として送られる（`String.valueOf(i)`）。
  - `month` は 1-12（0 始まりではない）。
  - `timeZone` は省略可（`ZoneId` 名）。
- **レスポンス**
  ```json
  { "days": [1, 4, 5, 12, 18, 19, 20, 30] }
  ```
  **投稿がある「日」（1-31 の整数）の配列のみ。件数は返らない。**
- **モデル**：`List<Integer>`（専用クラスなし）
- **根拠**：`sources/defpackage/fm.java:1443-1466`（リクエスト）, `:1471-1486`（`days` のパース）
- **メモ**
  - 月単位のみ。範囲指定は不可。
  - 設計書 6 章の `GET /api/groups/:id/calendar?month=YYYY-MM` は「日付だけ」を返す形に修正が必要（濃淡表示に件数を使うなら、日別 API を叩いて数えるか、`days` のみで二値表示にする）。
  - 過去日でも 1 リクエストで済むので、バックフィルの計画には使いやすい。

### 4.6 動画取得

クリップ 1 本の取得は 3 段階。

1. 4.4 のレスポンスから `media[].path`（例：`media-v2/shared-media/xxxx.enc`）を得る
2. `GET https://media.newchatapi.com/<path>` で**暗号文**をダウンロード（ヘッダー不要・署名不要【推測】）
3. `keys[]` のうち自分（`uid` == 自分の userId）の項目を使って復号する

| 項目 | 結果 | 根拠 |
| --- | --- | --- |
| 形式（mp4 / HLS / その他） | **mp4 / QuickTime（progressive）**。HLS の実装なし | `sources/defpackage/wc3.java:60` の MIME 候補 `{contentType, mimeType, "application/octet-stream", "video/quicktime", "video/mp4"}`。`m3u8` の参照は `my4.java:897`（拡張子判定のみ） |
| URL の種類 | 【推測】**署名なし・認証ヘッダー不要**。ただし**中身は暗号文**。`media.newchatapi.com` の URL を組み立てる関数は `c24.a()` だけで、ヘッダーを付ける処理が無いため | `sources/defpackage/c24.java:32`（URL 組み立て）, `sources/defpackage/yh2.java:66-70`（素の `GET`、この経路自体は融合で未使用） |
| 署名付き URL の有効期限 | 該当なし（署名なし） | — |
| `Range` リクエスト対応 | 【推測】CDN としては対応している可能性が高いが、**アプリは使っていない**。ChaCha20-Poly1305 のストリーム暗号なので部分復号はできず、実用上 `Range` は使えない | `sources/defpackage/pb3.java:48-80`（先頭 12 バイトの nonce から 64 KiB ブロック単位で AEAD を進める） |
| 1 本あたりのサイズ | **見つからない**（動的計測が必要） | — |
| 解像度・ビットレート（自分） | **見つからない**。`media[].dimensions.{width,height}` に解像度だけ入る | `sources/defpackage/px5.java:1216-1252` |
| 解像度・ビットレート（他人） | **見つからない**。API 上の区別なし（同一 `media[]` 形式） | — |
| サムネイル | **API には無い**。クライアントが動画から生成して `cacheDir/collection-preview-thumbnails` に保存 | `sources/defpackage/mb1.java:92-96` |
| アップロード（参考） | `POST media/getUploadURL` `{contentType, region, encrypted}` → `{uploadUrl, region, key}` → `PUT <uploadUrl>`（S3 署名付き URL、`Content-Type` のみ）。`key` が `media[].path` になる | `sources/defpackage/y31.java:262-295`, `sources/defpackage/yh2.java:95-115` |

**注意：`GET https://media.newchatapi.com/<path>` をそのまま `<video src>` に渡しても再生できない。** 中身は ChaCha20-Poly1305 の暗号文で、先頭 12 バイトが nonce、以降 64 KiB + 16 バイト tag のブロック列。復号鍵は 4.7 の手順でしか得られない。

### 4.7 暗号化（E2EE）の実装 — 方式判定の根拠

**ここが方式 A / A′ を決める。**

| 項目 | 内容 | 根拠 |
| --- | --- | --- |
| 鍵交換 | **X25519**（`mx3.b(自分の秘密鍵, 相手の公開鍵)`） | `sources/defpackage/pb3.java:101-135` |
| KDF | **HKDF-SHA256**（salt = 32 byte、info = 下記の文字列、出力 32 byte） | `sources/defpackage/pb3.java:101-135` |
| info（**メッセージ本文／メディアの content key 用**） | `msg:enc:v{N}\|conv:{convId}\|msg:{msgId}\|sender:{senderId}\|type:{mime}`<br>`mediaCipherV >= 2` のメディアは `msg:enc:v2\|conv:media-v2\|msg:shared-media\|sender:{senderId}\|type:{mime}` | `sources/defpackage/pb3.java:158-182` |
| info（**content key のラップ／アンラップ用**） | `msg:enc:v1\|conv:{convId}\|msg:media-key\|sender:{senderId}\|type:application/octet-stream`<br>本文の info とは**別物**。さらに convId が空のときは `saved` も試す | `sources/defpackage/pb3.java:397-413` |
| 鍵ラップ | 自分の秘密鍵 × 送信者の公開鍵 → HKDF → その鍵で **ChaCha20-Poly1305** の `combinedB64` を開く = 32 byte の content key | `sources/defpackage/pb3.java:377-413`（`u()`）, `:31-46`（AEAD open） |
| 送信者公開鍵の検証 | `keys[].senderPublicKey` を base64 デコードし、その SHA-256 先頭 16 byte の base64url が `keys[].senderKid` と一致するか確認 | `sources/defpackage/pb3.java:135-156` |
| 本文 | `envelope = {v, alg:"CHACHA20-POLY1305", aadB64, combinedB64}`。`combinedB64` = 12 byte nonce + 暗号文 + 16 byte tag、AAD = info 文字列 | `sources/defpackage/sb3.java:1-40`, `sources/defpackage/pb3.java:252-280` |
| メディア | content key からさらに HKDF で導出した鍵で **ChaCha20-Poly1305 のストリーム暗号**。ファイル先頭 12 byte が nonce、以降 64 KiB + 16 byte tag のブロックを nonce インクリメントしながら並べる | `sources/defpackage/pb3.java:48-80`（`b()` 復号）, `:319-352`（`n()` 暗号化） |
| バージョン | `mediaCipherV`（int）。1 なら `convId/msgId` ベース、2 以上なら `media-v2/shared-media` ベース | `sources/defpackage/pb3.java:174-182`, `sources/defpackage/s43.java:155-172` |
| 復号の試行 | MIME 候補を 5 通り（`contentType`, `mimeType`, `application/octet-stream`, `video/quicktime`, `video/mp4`）試し、成功したものを使う。**正しい MIME が分からないと復号に失敗する** | `sources/defpackage/wc3.java:55-115` |
| **秘密鍵の保存先** | `SharedPreferences` **`setlog.identity`** に X25519 秘密鍵の**暗号文**を保存。復号鍵は **AndroidKeyStore** の `setlog.identity.master`（AES-256-GCM、**エクスポート不可**） | `sources/defpackage/z8.java:36,196-215,275-295` |
| 鍵バックアップ | `GET/POST auth/key-backup`。**PBKDF2-HMAC-SHA256（600,000 回）＋ ChaCha20-Poly1305** で端末外に保存。パスフレーズはサーバーに送らない | `sources/defpackage/oo4.java:329,1341-1346` |
| 鍵移行 | `key-transfer/sessions/...`（`kid`, `importedKid`, `deactivateOldDevice`）で旧端末から新端末へ | `sources/defpackage/ge3.java:1320,1881` |

**帰結**：サーバーも BFF も、`media.newchatapi.com` のバイト列を単独では復号できない。復号には
(a) 端末内の X25519 秘密鍵（AndroidKeyStore で保護、取り出し不可）、または
(b) ユーザーが設定した鍵バックアップのパスフレーズ（PBKDF2 600k）
のどちらかが必要。

(b) を使えば BFF でも復号できる（暗号方式はすべて移植可能）。ただし「パスフレーズを BFF に預ける」設計になるので、設計書 11 章の前提（トークンだけを秘密にする）を超える。MVP では (a)＝方式 A′ が素直。

---

## 5. 判定の見込み

| 判定項目 | 結果 |
| --- | --- |
| Web SDK から直接読めるか（C の条件） | **不可**。Firebase は FCM 専用、Supabase 等なし。データはすべて独自 REST |
| BFF から直接呼べるか（A の条件） | **メタデータは可、動画は不可**。`x-api-key` は固定値、署名なし、`jwt-key` を渡せば一覧・カレンダー・日別投稿は取得できる。ただし `media[].path` の実体は E2EE 暗号文で、BFF には復号鍵が無い（鍵は AndroidKeyStore 内、エクスポート不可） |
| 端末でしか取得できないか（A′ の条件） | **動画だけは A′ が必須**。テキスト・メタデータは A で足りる |
| **採用方式** | **A ＋ A′ のハイブリッド**（メタデータは BFF 中継、動画は cutlog から） |
| 判定理由 | 1. 認証はメール OTP で再現可能（`auth/email/login/start` → `verify`）で、`x-api-key` も固定値。メタデータ系 API に端末証明は無い。2. 動画は ChaCha20-Poly1305 で暗号化され、鍵は AndroidKeyStore 保護の X25519 秘密鍵でしか開けない。3. したがって「BFF がメタデータを取り、cutlog（Morphe パッチ）が端末で復号した mp4 を BFF にアップロードする」形が最小構成。 |

**A′ の実装方針（案）**

- cutlog 側：アプリ内で 4.4 → 4.6 を実行し、復号済み mp4 を `POST /api/admin/clip` で BFF に送る。必要なのは「clip のメタデータ（group/date/hour/member/capturedAt/durationMs）＋ mp4 バイト列」。
- BFF 側：メタデータだけならトークン 1 個で完結。動画は R2 に置き、`/api/clips/:id/media` は R2 の署名付き URL へ 302。
- どうしても BFF で動画を復号したい場合は、ユーザーに鍵バックアップのパスフレーズを入力させ、`GET auth/key-backup` → PBKDF2 → X25519 秘密鍵を取り出す実装が可能（ただしパスフレーズ保管のリスクを設計書 11 章に追記する必要がある）。

---

## 6. 設計書への反映が必要な点

1. **日付の境界が 0 時ではなく 4 時**（`sources/defpackage/wh1.java:1283`）。設計書 7 章の `date: YYYY-MM-DD` と `hour: 0–23` の定義を「現地 04:00 起点の 24 枠」に直す。カレンダーの `days` も同じ境界。
2. **`hour` は API が返さない**。`capturedAt`（= `timestamp`）から `04:00` 起点で計算する。設計書 7 章の「API が時間枠を返すならその値を優先する」は不要（返らない）。
3. **認証ヘッダーは `jwt-key` であって `Authorization: Bearer` ではない**。設計書 5 章・6 章の記述を差し替える。
4. **リフレッシュトークンが存在しない**。設計書 5 章の「期限の5分前にリフレッシュ」「401 でリフレッシュ」は成立しない。`GET user/profile` でトークンが更新されるか（動的確認）を前提に、「失効したらメール OTP をやり直す」経路を設計に入れる。
5. **動画は E2EE で、方式 A では取得できない**。設計書 3 章の取得方式表で「A ＋ A′」を明記し、8 章の「署名付き URL なら 302」は成立しない（署名なし・暗号文）と書き換える。
6. **`/api/groups/:id/calendar` は件数を返せない**。設計書 6 章のキャッシュ表と 10 章の「日ごとの投稿数を濃淡で表示」を、「投稿あり/なしの二値」か「日別 API を叩いて数える」に変更する。
7. **サムネイル API が無い**。設計書 6 章の `/api/clips/:clipId/thumb` は、端末側で生成したサムネイルをアップロードする形に変更する（または `<video preload="metadata">` の先頭フレームで代替）。
8. **グループは「collection」と呼ばれる**。`/api/groups` の内部実装は `GET /collections`。ソロログも同じ collection として扱われる可能性が高い（動的確認）。
9. **SSL ピンニングは無いが、`network_security_config` がユーザー CA を拒否する**。設計書 4 章のパッチ手順に「`network_security_config.xml` に `<certificates src="user"/>` を追加」を明記する（ピンニング解除だけでは足りない）。

---

## 7. 動的解析で確かめるべき点

優先度順。すべて静的解析では確定できなかったもの。

> **動的解析（2026-11-18）で大半を確定。** 結果は [api.md 第0節](api.md) と [design.md 14章](design.md)、実レスポンスは `fixtures/` を参照。主な確定：必須ヘッダーは `jwt-key` のみ（1）／メール OTP を curl で再現（2）／`user/profile` はトークン非返却＝ローテーションなし・JWT に `exp` なし（3,4）／ソロログは `collections` に含まれ DM は別経路（7）／動画 CDN は無認証200・1.43MB・Range206（13,14,15,17）。**静的の訂正**：メッセージの `media` は配列でなく**単一オブジェクト**、`permission` は `allow_saving`、日別は `beforeTimestamp` 形式と `startTimeInterval` 形式の両方が通る。

### 必須（方式 A ＋ A′ の成立条件）

1. **`x-api-key: 7CApGF***` と `jwt-key: <token>` の 2 つだけで `/collections` が 200 を返すか。** `User-Agent` やその他のヘッダーを外しても通るか。→ 設計書 4 章 手順 4（ヘッダーを 1 つずつ外す）をそのまま実施。
2. **メール OTP ログインを BFF（Cloudflare Workers）から再現できるか。** `auth/email/login/start` にレート制限・bot 対策・IP 制限があるか。`auth/email/login/verify` のレスポンスに `user.token` が入るか。
3. **`GET user/profile` が新しい `token` を返すか。** 返すならトークンがローテーションする（= 有効期限あり）。返さないなら無期限。
4. **トークンの形式と寿命。** `jwt-key` の値を base64 デコードして `exp` があるか。1 日・1 週間・1 か月放置して 401 になるか。
5. **復号済み mp4 を cutlog から BFF に送る経路の実現性。** Morphe パッチで `bw0.B()`（`sources/defpackage/bw0.java:662`）の戻り値 `File` をフックできるか。復号後のファイルが `cacheDir/message-media/` に残るタイミング。
6. **`keys[]` のうち自分宛の項目の選び方。** `uid == 自分の userId` で確定か（`sources/defpackage/pb3.java:233-236` は `mc3.h(userId, kid)` で探している）。`kid` が現在の端末鍵と一致しない場合（別端末で投稿された過去分）にどうなるか。

### データ形状の確定

7. **`GET collections` にソロログが含まれるか。** 含まれるなら `type` / `roomType` / `participants.length` の値は何か。DM が混ざるか。
8. **`messages[]` の 1 日分が 24 件を超えるか。** 同一時間枠に複数メンバーの投稿がある場合の並び順（`timestamp` 昇順か）。
9. **`messageDaysInMonth` の `timeZone` を省略した場合のサーバー既定値。** 端末が Asia/Tokyo でない場合に `days` がずれるか。
10. **`days` に 0 や 32 が混ざらないか**（パーサは `> 0` でフィルタしている：`sources/defpackage/fm.java:1481`）。
11. **未投稿枠の表現。** `messages[]` に「空メッセージ」が入るのか、単に欠落するのか。
12. **`media[].permission` の値。** `SAVING` 以外（`view_once` 系）が返るクリップがあるか。あると保存・再生の扱いが変わる。

### 動画の実測（`docs/api.md` 4.6 の表を埋める）

13. **`https://media.newchatapi.com/<path>` を無認証で GET できるか。** 200 で暗号文が返るか、403 か。
14. **`Range: bytes=0-1023` が通るか。** 通っても復号できないので実用性は低いが、CDN の挙動として記録。
15. **1 本のサイズ・解像度・ビットレート。** 自分／他人のクリップで差があるか（設計書 14 章の「グループのクリップを拡大できない仕様が API 側でも低解像度か」の確認）。
16. **`media[].dimensions` が常に入るか。** 入らない場合、縦横比の判定をどうするか。
17. **`Content-Type` / `Content-Length` / `ETag` / `Cache-Control` の値。** R2 にアーカイブする際のメタデータ保存に使う。
18. **アップロード URL の形式。** `POST media/getUploadURL` の `uploadUrl` が S3 の presigned URL か（ホスト名・クエリパラメータ）。有効期限は何秒か。

### その他

19. **`x-api-key` が将来ローテーションされるか。** アプリ更新で値が変わる可能性があるので、`lib/setlog` では定数として 1 か所に閉じ込め、変更検知のログを出す。
20. **WebSocket `wss://ws.newchatapi.com/` の必要性。** ポーリングだけで新着を取れるなら BFF では WS を実装しない（実装コストとレート制限の観点）。
21. **`code=account_locked` 以外の 403 の意味。** `auth/diagnostics` に送られる `authMethod` の値と合わせて、弾かれた理由を切り分けられるようにする。
