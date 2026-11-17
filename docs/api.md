# setlog API 仕様（解析メモ）

フェーズ0 の成果物。完了条件は「6 操作分の仕様が埋まっていること」（[設計書 第13章](design.md)）。

- 解析対象のアプリバージョン：`未記入`（例：1.2.3 / versionCode 123）
- 解析日：`未記入`
- 生のキャプチャは `captures/` に置く（git 管理外）。伏せ字にしたものだけを `fixtures/` に置く（[fixtures/README.md](../fixtures/README.md)）

詳細と根拠（ファイル:行）は [static-analysis.md](static-analysis.md) を参照。ここは要点のみ。状態：静的＝jadx で確認、動的＝キャプチャで確認、未＝未確認。

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
| 有効期限 | コード上に期限チェックなし。`GET user/profile` が新 `token` を返すかは未確認（返すならローテーション、返さないなら無期限） | 未 |
| リフレッシュトークン | 存在しない。失効時はメール OTP をやり直す経路になる | 静的 |
| 端末紐付け | ヘッダーとしてはなし。ただし E2EE の端末鍵が AndroidKeyStore に固定されるため、動画の復号は実質端末依存 | 静的 |
| BFF からログインを再現できるか | メール OTP なら再現可能の見込み（bot 対策・レート制限は要動的確認）。Google／パスキーは端末必須 | 未 |

## 3. 必須ヘッダー

ヘッダーを1つずつ外して再送し、結果を記録する（設計書 第4章 手順4）。

| ヘッダー | 値の形（伏せ字） | 外したときの結果 | 必須か |
| --- | --- | --- | --- |
| `x-api-key` | 40 文字の固定値（バイトコード直書き） | 常に付く。API Gateway のキー | 静的（動作は未） |
| `jwt-key` | `<token>`（`Bearer` なし） | 認証必須 API に付く | 静的（動作は未） |
| `Content-Type` | `application/json` | GET でも付く | 静的 |
| `User-Agent` | `okhttp/4.12.0`（既定） | アプリ独自 UA なし | 静的 |
| アプリバージョン系 | ヘッダーにはなし（`POST auth/diagnostics` のボディにのみ入る） | — | 静的 |
| 端末 ID 系 | ヘッダーにはなし | — | 静的 |
| 署名・タイムスタンプ系 | なし（HMAC / SigV4 なし） | — | 静的 |

認証に使うのは `x-api-key`（固定）＋`jwt-key`（トークン）の 2 本。署名は無いので静的解析だけで再現できる見込み。各ヘッダーを 1 つずつ外して実際に何が必須かは動的解析で確定する（設計書 4 章 手順 4）。

## 4. 操作ごとの仕様

各操作で共通の書式：

- **リクエスト**：メソッド、パス、クエリ、ボディ
- **レスポンス**：主要フィールドと型（zod スキーマ名）
- **フィクスチャ**：`fixtures/` のファイル名
- **メモ**：ページング、タイムゾーン、エラー時の形など

レスポンスの JSON 例とモデルクラスは [static-analysis.md 第 4 節](static-analysis.md) にある。ここは各操作のエンドポイントと確認すべき点のみ。

### 4.1 ログイン

- リクエスト：`POST auth/email/login/start` `{email, language}` → `POST auth/email/login/verify` `{email, code, language}`
- レスポンス：`{ "user": { …, "token": "<token>" } }`。`status: "needs_onboarding"` なら新規登録フロー
- フィクスチャ：`auth.login.json`（未取得）
- メモ：状態＝静的。OTP の再送制限・bot 対策はコード上に見えないが、サーバー側判定は動的確認

### 4.2 トークン更新

- リクエスト：`GET user/profile`（パラメータなし）
- レスポンス：`{ "user": { …, "token"? } }`。`token` があれば差し替え、無ければ既存継続
- フィクスチャ：`user.profile.json`（未取得）
- メモ：状態＝静的。**応答に `token` が入るか**が有効期限の鍵。入らなければ無期限、入ればローテーション

### 4.3 グループ一覧

- リクエスト：`GET collections`（`?lastEvaluatedKey=<opaque>` でページング）
- レスポンス：`{ "collections": [ { id, participants[], name, type, roomType, maxParticipants, memberProfiles{}, … } ], "lastEvaluatedKey" }`
- フィクスチャ：`groups.list.json`（未取得）
- メモ：状態＝静的。`type`（conversation=DM / collection=グループ）と `roomType`（log / vlog / stack）の 2 軸。**ソロログがここに含まれるか**（participants が自分 1 人の会話として返るか）は動的確認

### 4.4 日付ごとの投稿（24 枠のクリップ一覧）

- リクエスト：`GET chat/{collectionId}/messages?startTimeInterval=<ms>&endTimeInterval=<ms>`。`startTimeInterval` は**現地 04:00 起点**の日の開始、`end` は +86,400,000
- レスポンス：`{ "messages": [ { messageId, senderId, timestamp, contentType, media[], keys[], envelope, mediaCipherV } ], "hasMore", "nextSinceTimestamp" }`
- フィクスチャ：`days.today.json` / `days.past.json`（未取得）
- メモ：状態＝静的。**時間枠（hour）は API が返さない**。`timestamp` から 04:00 起点で算出。タイムゾーンは端末の `ZoneId.systemDefault()`。未投稿枠は欠落するのでクライアントで 24 枠を埋める

### 4.5 カレンダー

- リクエスト：`GET collection/{collectionId}/messageDaysInMonth?year=YYYY&month=M&timeZone=Asia/Tokyo`（**単数形 `collection/`**、`month` は 1-12）
- レスポンス：`{ "days": [1, 4, 5, …] }`（投稿がある日の整数配列**のみ。件数は返らない**）
- フィクスチャ：`calendar.month.json`（未取得）
- メモ：状態＝静的。月単位のみ。濃淡表示に件数が要るなら日別 API を叩いて数えるか、二値表示にする

### 4.6 動画取得

- リクエスト：4.4 の `media[].path` を使い `GET https://media.newchatapi.com/<path>`（ヘッダー不要・署名なしの見込み）。中身は**暗号文**
- 復号：`keys[]` の自分宛（`uid == 自分の userId`）の項目から content key を開き、ChaCha20-Poly1305 で復号（第 4.7 節）
- フィクスチャ：`clips.media.*`（暗号文はコミットしない。メタデータのみ）
- メモ：下表。**暗号文なので `<video src>` に直接渡しても再生できない**

| 項目 | 結果 | 状態 |
| --- | --- | --- |
| 形式 | mp4 / QuickTime（progressive）。HLS なし | 静的 |
| URL の種類 | 署名なし・認証ヘッダー不要の見込み。ただし中身は E2EE 暗号文 | 静的（動作は未） |
| 署名付き URL の有効期限 | 該当なし | — |
| `Range` 対応 | CDN は対応の可能性。ただしストリーム暗号で部分復号できず実用性低 | 未 |
| 1 本あたりのサイズ | 未（動的計測） | 未 |
| 解像度（自分 / 他人） | `media[].dimensions` に解像度のみ。ビットレートは未計測。自他の差も未確認 | 未 |
| サムネイル | API になし。クライアントが動画から生成してキャッシュ | 静的 |

### 4.7 暗号化（E2EE）— 方式判定の根拠

- 鍵交換 X25519 ＋ HKDF-SHA256、本体 ChaCha20-Poly1305。詳細な info 文字列・ブロック構造は [static-analysis.md 第 4.7 節](static-analysis.md)
- **X25519 秘密鍵は AndroidKeyStore（`setlog.identity.master`、AES-256-GCM、エクスポート不可）で保護**。サーバーも BFF も単独では復号できない
- 復号に必要なのは (a) 端末内の秘密鍵、または (b) 鍵バックアップのパスフレーズ（PBKDF2-HMAC-SHA256 60 万回）
- 帰結：動画は方式 A（BFF 中継）では取れない。A′（端末で復号してアップロード）が必要

## 5. 判定

| 判定項目 | 結果 |
| --- | --- |
| Web SDK から直接読めるか（C の条件） | 不可。Firebase は FCM 専用、データは独自 REST |
| BFF から直接呼べるか（A の条件） | メタデータは可（`x-api-key` 固定・署名なし・`jwt-key` でアクセス）。動画は不可（E2EE、鍵は端末内） |
| 端末でしか取得できないか（A′ の条件） | 動画のみ A′ 必須。テキスト・メタデータは A で足りる |
| **採用方式** | **A ＋ A′ のハイブリッド**（メタデータは BFF 中継、動画は cutlog から復号アップロード） |
| 判定理由 | 認証はメール OTP で再現可能の見込みで端末証明なし。動画は AndroidKeyStore 保護の X25519 鍵でしか復号できない。よって「BFF がメタデータ、cutlog が端末で復号した mp4 をアップロード」が最小構成 |

> この判定は静的解析ベース。動的解析（第 7 節）で「`x-api-key`＋`jwt-key` だけで `/collections` が通る」「メール OTP を BFF から再現できる」が確認できたら確定する。

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
