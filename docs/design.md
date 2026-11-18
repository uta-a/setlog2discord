# setlog Webビューア 設計書

Nov 17, 2026 · @uta\_a

## 1. 概要

setlog のログ（毎時2秒の動画）を、PC やタブレットのブラウザで見返せる自分専用の Web ビューアを作る。setlog に公式の Web 版はないため、アプリの非公開 API を解析し、自前の BFF を経由して取得する。

**目的**

- 自分のログとグループのログを、日付・時間枠ごとに大きな画面で見返す
- 1日分のクリップを連続再生し、Vlog として見る
- 過去分を自前ストレージに保存し、アプリ側の仕様変更や削除の影響を受けないようにする（フェーズ2）

**スコープ外**

- Web からの撮影・投稿（cutlog の Morphe パッチ側で扱う）
- 他人への公開・共有機能
- 複数ユーザーでの利用（自分のアカウント1つだけ）

## 2. 前提と制約

前提は「非公開 API を自分のアカウントで、自分だけが使う」こと。この前提が崩れる機能は作らない。

- **非公開 API**：仕様は予告なく変わる。アプリ更新で壊れる前提で、API クライアントを1モジュールに閉じ込める
- **利用規約**：リバースエンジニアリングや非公式クライアントは規約違反になりうる。アカウント停止のリスクを許容し、リクエストはアプリ並みかそれ以下の頻度に抑える
- **プライバシー**：グループログには友達の動画が含まれる。サイトは常に認証をかけ、公開・再配布はしない。アーカイブも自分専用の非公開バケットに置く
- **アプリの仕様**：1時間に1回・約2秒の動画、未投稿の時間枠は黒い画面、グループは最大20人、過去分はカレンダーから見返せる（[Real Sound](https://realsound.jp/tech/2026/07/post-2470848.html)、[comnico](https://www.comnico.jp/we-love-social/setlog-enter)）

## 3. 全体アーキテクチャ

ブラウザと setlog の間に BFF を置き、setlog を知っているのは BFF 内の `lib/setlog` だけにする。フェーズ2 で同期ジョブと D1 / R2 を足す。

&#91;embedded content: 全体構成 · Cloudflare Workers 上の BFF と同期ジョブ\]

ブラウザは Access を通って BFF だけを呼ぶ。cutlog は解析とトークン登録を担当し、同期ジョブは過去分を自前ストレージに移す。

**取得方式（第4章の解析結果で確定）**

| 方式 | 中身 | 手間 | API 変更への強さ |
| --- | --- | --- | --- |
| A：BFF 中継 | リクエストごとに BFF が setlog を呼ぶ | 小 | 弱い |
| A′：端末から取得 | cutlog がアプリ内で取得し BFF に送る | 大 | 中 |
| B：アーカイブ | 同期ジョブが保存し、Web は自前ストレージを読む | 中 | 強い（過去分は残る） |
| C：Web SDK 直接 | Firebase / Supabase 等をブラウザから読む | 最小 | 中 |

MVP は A（使えなければ A′）で作り、フェーズ2 で B を重ねる。

> **解析結果（2026-11-18、動的解析で確定）**：採用は **A＋A′ のハイブリッド**で確定。メタデータ（グループ・カレンダー・日別投稿）は方式 A（BFF 中継）で取れることを実機キャプチャ＋curl 再現で実証（**必須ヘッダーは `jwt-key` のみ**、`x-api-key` すら `/collections` では不要、署名・端末証明なし）。**動画は X25519＋ChaCha20-Poly1305 の E2EE で、復号鍵が端末の AndroidKeyStore に固定（エクスポート不可）**のため方式 A では取得できず、A′（cutlog が端末で復号して BFF にアップロード）が必須。方式 C（Web SDK 直接）は不可（Firebase は FCM 専用、データは独自 REST）。詳細は [api.md](api.md)・[static-analysis.md](static-analysis.md)・[dynamic-analysis.md](dynamic-analysis.md)。

## 4. API 解析計画

最初に「バックエンドが何か」を確定させる。ここで方式 A（BFF 中継）か C（Web SDK 直接）かが決まる。

1. **静的解析**：jadx で APK を開き、ベース URL、Retrofit/OkHttp のインターフェース、`google-services.json` 由来の Firebase 設定、Supabase 等の URL を探す
2. **動的解析**：HTTP Toolkit か mitmproxy で通信をキャプチャ。SSL pinning は cutlog の Morphe パッチで解除する（line-patch と同じ手順）。**解析結果（2026-11-18）：SSL pinning（CertificatePinner）は無い。ただし `network_security_config.xml` がユーザー CA を信頼しないため、覗くにはピンニング解除だけでは足りず、同ファイルに `<certificates src="user"/>` を追加するパッチが必要。**
3. **操作ごとに記録**：ログイン / トークン更新 / グループ一覧 / 日付ごとの投稿 / カレンダー / 動画取得をアプリで操作し、リクエストとレスポンスを保存する
4. **必須ヘッダーの特定**：Authorization、User-Agent、アプリバージョン、端末 ID、署名系ヘッダーを一つずつ外して、何がないと弾かれるかを確かめる
5. **API 仕様書化**：結果を `docs/api.md` と TypeScript 型（zod スキーマ）にまとめる。実レスポンスはテスト用フィクスチャとして保存

判定基準：

| 解析結果 | 採用方式 |
| --- | --- |
| Firebase / Supabase で、Web SDK から読める（App Check なし） | C：Web SDK 直接 |
| 独自 REST / GraphQL API | A：BFF 中継 |
| 署名が端末内の鍵で計算され、再現できない | A′：Morphe パッチが端末から取得し、サーバーへアップロード |

## 5. 認証・トークン管理

setlog のトークンは BFF だけが持ち、ブラウザには渡さない。Web のログインと setlog の認証は別物として扱う。

**トークンの入手（優先順）**

1. ログイン API を BFF で再現できる場合：管理画面からメール OTP でログインし、`user.token` を取得
2. SMS 認証や端末紐付けで再現できない場合：cutlog の Morphe パッチに「トークンを BFF に送る」ボタンを足し、`POST /api/admin/token` で登録（管理用の共有シークレットで保護）

> **解析結果（2026-11-18、動的解析で確定）**：
> - ログインは**メール OTP**（`auth/email/login/start` → `/verify`）。SMS は無い。**BFF からの再現を実測**（curl で `start`→`verify` が 200、`verify` 応答に `token`）。認証ヘッダーは `jwt-key: <token>`（`Authorization: Bearer` ではない）。**`x-api-key` は `/collections` では不要**だが login 等では必要な可能性があり送る。
> - **リフレッシュトークンは存在しない。** トークンは **HS256 JWT で `exp` なし**、`GET user/profile` も `token` を返さない＝**ローテーションしない** → 実質長期有効。「期限の5分前／401 でリフレッシュ」は不成立。
> - 失効時は**メール OTP をやり直す**しかない。

**保管と更新**

- 保管先：Cloudflare KV（または D1）に暗号化して保存。暗号化鍵は Workers Secret
- 更新：リフレッシュトークンが無いので、`GET user/profile` の応答に新 `token` があれば差し替える。**失効（401）したら自動回復できず「再登録が必要」状態にし、管理画面でメール OTP をやり直す**
- 同時更新の防止：トークン差し替えはロック（Durable Object か KV のフラグ）で直列化する
- 失効時の通知：Discord Webhook へ「トークン再登録が必要」を送る

## 6. BFF 設計

BFF は Next.js の Route Handlers で実装し、setlog のレスポンスを自前の型に変換して返す。UI は setlog の生の形を知らない。

| メソッド | パス | 内容 | キャッシュ |
| --- | --- | --- | --- |
| GET | `/api/groups` | 所属グループ一覧（自分のソロログ含む）。内部は `GET /collections` | 10分 |
| GET | `/api/groups/:groupId/calendar?month=YYYY-MM` | 月内の投稿がある日（件数は返せない。後述） | 10分 |
| GET | `/api/groups/:groupId/days/:date` | その日の24枠 × メンバーのクリップ一覧 | 当日：1分、過去日：1日 |
| GET | `/api/clips/:clipId/media` | 動画本体。MVP ではアーカイブ済み（R2）のみ返す（後述） | ブラウザ側に任せる |
| GET | `/api/clips/:clipId/thumb` | サムネイル（端末生成分のみ。後述） | 1日 |
| POST | `/api/admin/token` | setlog トークンの登録（cutlog から） | — |
| POST | `/api/admin/clip` | 復号済み mp4 ＋メタデータの登録（cutlog から、方式 A′） | — |
| GET | `/api/admin/status` | トークンの有効性、最終同期日時 | — |

**実装方針**

- setlog への通信は `lib/setlog/client.ts` に集約。必須ヘッダー（`x-api-key`＋`jwt-key`）、リトライ、レート制限（例：毎秒1件）をここで持つ
- レスポンスは zod で検証し、形が変わったら「API 仕様変更」エラーとしてログと通知を出す
- フェーズ2以降は、過去日のリクエストをアーカイブ（D1 + R2）から先に返す。無ければ setlog に問い合わせる

> **解析結果（2026-11-18）で変わる点**：
> - **グループ一覧の実体は `GET /collections`**（`type`＝conversation/collection、`roomType`＝log/vlog/stack の 2 軸）。ソロログがここに含まれるかは動的確認。
> - **カレンダー（`collection/{id}/messageDaysInMonth`）は投稿がある日の整数配列だけを返し、件数は返さない。** `/api/groups/:id/calendar` も「投稿あり/なしの二値」にするか、濃淡表示が要るなら日別 API を叩いて数える。
> - **動画は E2EE で BFF 単独では復号できない**ため、`/api/clips/:id/media` は「署名付き URL なら 302、でなければ中継」が成立しない。MVP では cutlog が `POST /api/admin/clip` でアップロードした復号済み mp4（R2）を返す。
> - **サムネイル API は setlog 側に無い。** 端末が動画から生成するので、cutlog が mp4 と一緒に送るか、`<video preload="metadata">` の先頭フレームで代替する。

## 7. データモデル

自前の型は4つ。setlog 側の ID は `sourceId` として保持し、内部 ID と分ける。フェーズ2ではこのまま D1 のテーブルになる。

```ts
type Group = {
  id: string;          // 内部 ID
  sourceId: string;    // setlog 側の ID
  name: string;
  isSolo: boolean;     // 自分だけのログか
  memberIds: string[];
};

type Member = {
  id: string;
  sourceId: string;
  displayName: string;
  avatarUrl?: string;
};

type Clip = {
  id: string;
  sourceId: string;
  groupId: string;
  memberId: string;
  date: string;        // YYYY-MM-DD（現地 04:00 起点の「日」。04:00 未満は前日扱い）
  hour: number;        // 0–23 の時間枠（04:00 起点。capturedAt から算出。API は返さない）
  capturedAt: string;  // ISO 8601
  durationMs: number;  // 約 2000
  mediaKey?: string;   // アーカイブ済みなら R2 のキー
  sourceMediaUrl?: string;
};

type DayView = {
  groupId: string;
  date: string;
  slots: { hour: number; clips: Clip[] }[]; // 常に 24 件。空なら未投稿
};
```

日付と時間枠は setlog の表示に合わせて Asia/Tokyo で計算する。

> **解析結果（2026-11-18）**：**「日」の境界は 0 時ではなく現地 04:00**（アプリは `getHour() < 4` のとき前日扱いし、`atTime(4,0)` から 24 時間を 1 日分として問い合わせる）。`hour` は API が返さないので `capturedAt`（＝`timestamp`）から 04:00 起点で算出する（`hour = ((timestamp - その日の04:00) / 3,600,000)`、0–23）。アプリは端末の `ZoneId.systemDefault()` を使うので、表示を一致させるには端末が Asia/Tokyo である必要がある。「API が時間枠を返すならその値を優先する」は不要（返らない）。
>
> **動的解析で確定（2026-11-18）**：メッセージの `media` は**配列でなく単一オブジェクト**（1 メッセージ＝1 クリップ）。`Clip` へのマッピングは `media.path`（CDN パス）・`media.mimeType`・`media.dimensions{width,height}`・`media.permission`（`allow_saving`）・`timestamp`→`capturedAt`/`date`/`hour`・`senderId`→`memberId`・`messageId`/`conversationId`→`sourceId`/`groupId` で行う。復号鍵は `keys[]` の `uid == 自分の userId` の項目。`durationMs` は API に無いので復号後の mp4 から求める。

## 8. 動画配信・再生

動画は可能な限り CDN から直接再生し、BFF の中継は必要なときだけにする。Workers の帯域と CPU 時間を節約するため。

> **解析結果（2026-11-18）で前提が変わる**：setlog の動画（`media.newchatapi.com` のバイト列）は **X25519＋ChaCha20-Poly1305 の E2EE 暗号文**で、`<video src>` にそのまま渡しても再生できない。復号鍵は端末の AndroidKeyStore 内（エクスポート不可）にあり、BFF では開けない。HLS は使われておらず、形式は mp4（progressive）。

> **復号スパイクの結果（2026-11-18、実クリップで実証）**：暗号方式を `lib/setlog/crypto.ts` に移植し、実鍵で端から端まで復号に成功した（バックアップのパスフレーズ → PBKDF2-HMAC-SHA256 60万回 → 秘密鍵復元 → content key アンラップ → メディア復号 → 正規の mp4（H.264 720p / 2.1秒）を生成、ffprobe で再生確認）。メディア本体は **content key そのもの**で、ファイル全体を1回の ChaCha20-Poly1305（nonce12＋暗号文＋tag16、AAD=content info）で復号する。これで**動画経路の 2 案が両方とも技術的に成立する**ことが分かった：
>
> | 案 | 復号の場所 | 鍵の置き場所 | 長所 | 短所 |
> | --- | --- | --- | --- | --- |
> | **A′**（端末復号） | cutlog（アプリ内） | 端末内のみ | 信頼境界を変えない。設計書11章の前提を守る | cutlog 側の実装が要る。端末が無いと取れない |
> | **サーバー復号**（実証済み） | BFF / 同期ジョブ | **バックアップのパスフレーズ or 復元した秘密鍵をサーバーが保持** | 端末不要。過去分のバックフィルが楽。暗号は移植済み | **E2EE の秘密鍵が端末外に出る**（設計書11章の「トークンだけを秘密にする」を超える）。Workers の WebCrypto は chacha20-poly1305 非対応の可能性があり別実装が要る |
>
> **重要な運用上の制約**：端末を再登録すると identity 鍵がローテーションし、**旧鍵で暗号化された過去クリップは新鍵では復号できない**（今回の再パッチでも 11/4 のクリップが開けなくなった）。どちらの案でも、アーカイブ（フェーズ2）の前に鍵バックアップを取り、鍵の世代（`kid`）ごとに秘密鍵を保全する必要がある。
>
> MVP の動画所在（下表）は R2 の平文 mp4 を前提にする。そこへ平文を入れるのが A′（cutlog アップロード）かサーバー復号（同期ジョブが復号）かは未確定。

**配信の分岐**（R2 の平文 mp4 を前提に整理し直す）

| 動画の所在 | 処理 |
| --- | --- |
| R2 にアーカイブ済み（復号済み mp4） | R2 の署名付き URL を返す（期限 10 分） |
| 未アーカイブ | 再生不可。cutlog でのアップロード待ち（`/api/admin/status` に状態を出す） |

**Vlog の連続再生**

- 方式：2つの `<video>` 要素を交互に使うダブルバッファ。再生中に次のクリップを先読みし、`ended` で切り替える
- 未投稿の枠：設定で「飛ばす」か「黒画面を 0.5 秒表示」を選べるようにする
- グループの同じ枠に複数人いるとき：メンバー順に連続再生（初期値）か、グリッドで同時再生
- 1本の動画として保存したい場合は、フェーズ3で自宅の Ubuntu Server に ffmpeg `concat` のジョブを置く（Workers では動画を加工しない）

## 9. アーカイブ（フェーズ2）

Cron で毎時新着を取得し、メタデータを D1、動画を R2 に保存する。API が壊れても、保存済みの日はそのまま見られる。

**同期ジョブ**

1. Cron Trigger：毎時 10 分（投稿が出そろった後）に、当日と前日の `DayView` を取得
2. D1 に `sourceId` で upsert。新しいクリップだけを Queue に積む
3. Queue の consumer が動画を取得し、R2 の `clips/{groupId}/{date}/{hour}/{memberId}-{sourceId}.mp4` に保存。`mediaKey` を更新
4. 初回のみ過去分のバックフィル：カレンダーを月単位でさかのぼり、1日ずつ間隔を空けて取得

**容量の見積もり（仮）**

2秒のクリップを 1 本約 1 MB とすると、自分だけで 1 日最大 24 MB、年間約 9 GB。グループ 5 人分なら年間約 45 GB になる。R2 の無料枠（10 GB）を超えるため、保存対象のグループを設定で選べるようにする。実際の 1 本のサイズは API 解析時に測る。

## 10. フロントエンド UI

画面は4つ。アプリと同じ「24枠のグリッド」を中心にし、PC では拡大表示できるようにする。

| 画面 | パス | 主な要素 |
| --- | --- | --- |
| ホーム | `/` | グループ切り替え、月カレンダー（投稿がある日をマーク表示。カレンダー API は件数を返さないため濃淡は不可。濃淡が要る場合は日別 API を叩いて数える）、今日へのショートカット |
| 日別ビュー | `/g/[groupId]/[date]` | 24枠グリッド（未投稿は黒）、行＝メンバー、列＝時間。ホバーでプレビュー、クリックで拡大 |
| Vlog 再生 | `/g/[groupId]/[date]/play` | 全画面の連続再生、シークバーに時間枠の目盛り、←→キーで前後のクリップ |
| 管理 | `/admin` | トークン状態、最終同期、アーカイブ対象グループの選択 |

- スタック：Next.js（App Router）+ TypeScript + shadcn/ui + Tailwind。データ取得は TanStack Query
- 日別ビューはサムネイルを先に並べ、動画は表示領域に入ったものだけ読み込む（IntersectionObserver）
- スマホ幅ではグリッドを縦スクロールの時間リストに切り替える

## 11. セキュリティ・アクセス制御

サイト全体を Cloudflare Access の後ろに置き、自分のメールアドレス以外は入れない。アプリ側で認証を実装しなくて済む。

- **入口**：Cloudflare Access（ワンタイム PIN か Google ログイン）。BFF 側でも `Cf-Access-Jwt-Assertion` を検証し、直接アクセスを弾く
- **管理 API**：`/api/admin/*` は Access に加えて共有シークレットを必須にする。cutlog からの送信は Access の Service Token を使う
- **トークン**：setlog のトークンは暗号化して保存し、ログとエラーレポートには出さない
- **動画**：R2 は非公開バケット。配信は期限 10 分の署名付き URL のみ
- **検索エンジン**：`X-Robots-Tag: noindex` を全レスポンスに付ける
- **リポジトリ**：GitHub は private。API のフィクスチャには実データ（他人の名前・URL）を入れず、伏せ字にしてコミットする

## 12. 技術スタック・デプロイ

Cloudflare にまとめて、個人利用の範囲ならほぼ無料枠で動かす。

| 層 | 採用 | 備考 |
| --- | --- | --- |
| フロント / BFF | Next.js（App Router）を `@opennextjs/cloudflare` で Workers にデプロイ | Route Handlers が BFF |
| UI | shadcn/ui、Tailwind、TanStack Query、hls.js | — |
| 型・検証 | TypeScript、zod | setlog レスポンスの検証 |
| トークン保管 | Workers KV + Secret | 暗号化して保存 |
| メタデータ | D1（Drizzle ORM） | フェーズ2 |
| 動画保存 | R2 | フェーズ2 |
| 定期実行 | Cron Triggers + Queues | Queues が使えないプランなら Cron 内で逐次処理 |
| 認証 | Cloudflare Access | 無料枠（50 ユーザー）で足りる |
| 通知 | Discord Webhook | トークン失効・API 仕様変更 |
| 動画加工 | 自宅 Ubuntu Server の ffmpeg | フェーズ3。任意 |

**リポジトリ構成**

```
app/            # 画面と Route Handlers（/api/*）
lib/setlog/     # API クライアント、スキーマ、変換（ここだけが setlog を知る）
lib/archive/    # D1 / R2 への読み書き
workers/sync/   # Cron と Queue consumer
docs/api.md     # 解析した API 仕様
fixtures/       # 伏せ字済みのレスポンス例
```

## 13. フェーズ・マイルストーン

フェーズ0 の結果で方式が決まるため、それまでは UI に手をつけない。

**フェーズ0：API 解析**（完了条件：`docs/api.md` に 6 操作分の仕様がある）

- [x] jadx でベース URL とバックエンドの種類を特定
- [x] 通信をキャプチャ（SSL pinning は無し。`network_security_config` に `src="user"` を足した再パッチ＋mitmproxy で傍受）
- [x] 必須ヘッダーと認証方式を確定し、方式を決める（**A＋A′ に確定**。必須は `jwt-key` のみ）

フェーズ0 は完了。6 操作分の実レスポンスを `fixtures/` に伏せ字で保存済み。

**フェーズ1：MVP**（完了条件：PC のブラウザで今日のログを連続再生できる）

- [ ] `lib/setlog` のクライアントとトークン更新
- [ ] BFF の `/api/groups`、`/days/:date`、`/clips/:id/media`
- [ ] 日別ビューと Vlog 再生画面
- [ ] Cloudflare Access をかけて Workers にデプロイ

**フェーズ2：アーカイブ**（完了条件：setlog API を止めても過去日が見られる）

- [ ] D1 スキーマと Cron 同期
- [ ] R2 への動画保存とバックフィル
- [ ] カレンダーと管理画面

**フェーズ3：任意**

- [ ] ffmpeg で 1 日分を 1 本の mp4 に書き出す
- [ ] cutlog で編集した動画も同じストレージに置いて並べて見る

## 14. 未確定事項・リスク

**静的解析（2026-11-18）で判明した事項**（詳細は [static-analysis.md](static-analysis.md)）

- バックエンドは**独自 REST**（`api.newchatapi.com` / AWS API Gateway）。Firebase は FCM 専用、Supabase 等なし
- ログインは**メール OTP**。**リフレッシュトークン・有効期限はコード上に無い**（ローテーション有無は動的確認）
- **リクエスト署名・端末証明は無い**（`x-api-key` は固定値、Play Integrity / App Check なし）
- 動画は**mp4（progressive）**。ただし **E2EE 暗号文**で BFF 単独では復号できない。1 本のサイズは未計測
- 拡大できない仕様が低解像度配信かは未確認（`media[].dimensions` に解像度だけ入る）

**動的解析（2026-11-18）で解決した項目**

- ✅ 必須ヘッダーは `jwt-key` のみ（`x-api-key` すら `/collections` では不要、署名なし）
- ✅ メール OTP を curl で再現し `token` を取得（bot 対策・レート制限は今回未発火）
- ✅ `GET user/profile` は `token` を返さない＝ローテーションなし、JWT に `exp` なし＝実質長期有効
- ✅ 動画 CDN は無認証 GET 200、約 1.43MB / 720p、`Range` 206 対応、`application/octet-stream`
- ✅ ソロログは `collections` に含まれる（`type=collection`）。DM は別経路 `chat/conversations` で混ざらない
- ✅ `media` は単一オブジェクト（静的の `media[]` は誤り）、`permission=allow_saving`

**なお残る未確定**

- bot 対策・レート制限・IP 制限の閾値（今回は少数リクエストで止まらず、本格的な負荷は未試験）
- 他人のクリップの解像度・サイズ（自分の 720p / 1.43MB のみ実測）
- `roomType=stack` や `view_once` 系 `permission` のレスポンス（未観測）
- トークンの実失効（放置テスト未実施）

**リスクと対応**

| リスク | 影響 | 対応 |
| --- | --- | --- |
| アプリ更新で API が変わる | 新着が取れなくなる | zod 検証で検知して通知。フェーズ2 のアーカイブで過去分は守る |
| アカウント停止 | アプリ自体が使えなくなる | リクエスト頻度をアプリ並みに抑える。バックフィルは間隔を空ける |
| 動画が E2EE（**判明済み**） | 方式 A だけでは動画が出せない | A′（端末復号）か、バックアップのパスフレーズによるサーバー復号（**実証済み**）。どちらも平文 mp4 を R2 に置く |
| 端末再登録で identity 鍵がローテーション（**判明済み**） | 旧鍵で暗号化した過去クリップが復号不能になる | 再登録の前に鍵バックアップを取り、`kid` の世代ごとに秘密鍵を保全する |
| 秘密鍵をサーバーに置く（サーバー復号案を採る場合） | E2EE の信頼境界が広がる | 採用するなら設計書11章にリスクを明記。パスフレーズは保存せず都度入力、復元鍵はメモリ上のみ等の緩和を検討 |
| トークン失効時に自動回復できない（リフレッシュ無し） | 新着が止まる | 401 を「再登録が必要」状態にし、Discord 通知 → 管理画面でメール OTP やり直し |
| `x-api-key` がアプリ更新で変わる | API が一斉に 403 | `lib/setlog` で定数 1 か所に閉じ込め、変更を検知して通知 |
| 友達の動画の漏えい | 信頼とプライバシーの侵害 | Access、非公開 R2、短期限の署名 URL、フィクスチャの伏せ字 |
