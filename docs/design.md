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

## 4. API 解析計画

最初に「バックエンドが何か」を確定させる。ここで方式 A（BFF 中継）か C（Web SDK 直接）かが決まる。

1. **静的解析**：jadx で APK を開き、ベース URL、Retrofit/OkHttp のインターフェース、`google-services.json` 由来の Firebase 設定、Supabase 等の URL を探す
2. **動的解析**：HTTP Toolkit か mitmproxy で通信をキャプチャ。SSL pinning は cutlog の Morphe パッチで解除する（line-patch と同じ手順）
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

1. ログイン API を BFF で再現できる場合：管理画面から一度ログインし、アクセストークンとリフレッシュトークンを取得
2. SMS 認証や端末紐付けで再現できない場合：cutlog の Morphe パッチに「トークンを BFF に送る」ボタンを足し、`POST /api/admin/token` で登録（管理用の共有シークレットで保護）

**保管と更新**

- 保管先：Cloudflare KV（または D1）に暗号化して保存。暗号化鍵は Workers Secret
- 更新：期限の5分前、または 401 を受けたときにリフレッシュ。1回だけリトライし、失敗したら「再登録が必要」状態にする
- 同時更新の防止：リフレッシュはロック（Durable Object か KV のフラグ）で直列化する
- 失効時の通知：Discord Webhook へ「トークン再登録が必要」を送る

## 6. BFF 設計

BFF は Next.js の Route Handlers で実装し、setlog のレスポンスを自前の型に変換して返す。UI は setlog の生の形を知らない。

| メソッド | パス | 内容 | キャッシュ |
| --- | --- | --- | --- |
| GET | `/api/groups` | 所属グループ一覧（自分のソロログ含む） | 10分 |
| GET | `/api/groups/:groupId/calendar?month=YYYY-MM` | 月内の投稿がある日と件数 | 10分 |
| GET | `/api/groups/:groupId/days/:date` | その日の24枠 × メンバーのクリップ一覧 | 当日：1分、過去日：1日 |
| GET | `/api/clips/:clipId/media` | 動画本体。署名付き URL なら 302、そうでなければストリーミング中継 | ブラウザ側に任せる |
| GET | `/api/clips/:clipId/thumb` | サムネイル（あれば） | 1日 |
| POST | `/api/admin/token` | setlog トークンの登録（cutlog から） | — |
| GET | `/api/admin/status` | トークンの有効性、最終同期日時 | — |

**実装方針**

- setlog への通信は `lib/setlog/client.ts` に集約。必須ヘッダー、リトライ、レート制限（例：毎秒1件）をここで持つ
- レスポンスは zod で検証し、形が変わったら「API 仕様変更」エラーとしてログと通知を出す
- フェーズ2以降は、過去日のリクエストをアーカイブ（D1 + R2）から先に返す。無ければ setlog に問い合わせる

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
  date: string;        // YYYY-MM-DD（Asia/Tokyo）
  hour: number;        // 0–23 の時間枠
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

日付と時間枠は setlog の表示に合わせて Asia/Tokyo で計算する。API が時間枠を返すならその値を優先する。

## 8. 動画配信・再生

動画は可能な限り CDN から直接再生し、BFF の中継は必要なときだけにする。Workers の帯域と CPU 時間を節約するため。

**配信の分岐**

| 動画 URL の形 | 処理 |
| --- | --- |
| 署名付き URL（ヘッダー不要） | BFF が 302 リダイレクト。期限切れなら取得し直す |
| 認証ヘッダーや Cookie が必要 | BFF がストリーミング中継。`Range` ヘッダーをそのまま渡す |
| HLS（`.m3u8`） | hls.js で再生。Safari はネイティブ再生 |
| アーカイブ済み | R2 の署名付き URL を返す |

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
| ホーム | `/` | グループ切り替え、月カレンダー（日ごとの投稿数を濃淡で表示）、今日へのショートカット |
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

- [ ] jadx でベース URL とバックエンドの種類を特定
- [ ] Morphe で SSL pinning を外し、通信をキャプチャ
- [ ] 必須ヘッダーと認証方式を確定し、方式 A / A′ / C を決める

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

**未確定（フェーズ0 で決める）**

- バックエンドは独自 API か、Firebase / Supabase 等か
- ログイン方式と、トークンの有効期限
- リクエスト署名や端末証明（Play Integrity など）の有無
- 動画の形式（mp4 か HLS か）と1 本あたりのサイズ
- グループのクリップを「拡大できない」仕様が、API 側でも低解像度配信になっているか

**リスクと対応**

| リスク | 影響 | 対応 |
| --- | --- | --- |
| アプリ更新で API が変わる | 新着が取れなくなる | zod 検証で検知して通知。フェーズ2 のアーカイブで過去分は守る |
| アカウント停止 | アプリ自体が使えなくなる | リクエスト頻度をアプリ並みに抑える。バックフィルは間隔を空ける |
| 端末証明が必須 | BFF から直接取得できない | 方式 A′（cutlog が端末から取得してアップロード）に切り替える |
| 友達の動画の漏えい | 信頼とプライバシーの侵害 | Access、非公開 R2、短期限の署名 URL、フィクスチャの伏せ字 |
