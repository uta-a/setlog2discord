# setlog 動的解析ランブック

フェーズ0 の動的パート。静的解析（[static-analysis.md](static-analysis.md)）で「見込み」止まりの点を、実通信で確定させる。完了すると [api.md](api.md) 第5節「判定」の **A＋A′ ハイブリッド**が確定し、「状態＝静的」の行が「動的」に変わる。

- 解析対象アプリバージョン：`未記入`（キャプチャ開始時に `POST auth/diagnostics` のボディか端末の設定から記入）
- 解析日：`未記入`
- 原則：リクエスト頻度はアプリ並みかそれ以下（設計書2章）。生データは `captures/`（git 管理外）、伏せ字済みだけ `fixtures/`。

> 前提：通信を覗くためのパッチ版 setlog（`network_security_config` に `<certificates src="user"/>` を追加し、ユーザー CA を信頼する構成）が端末に導入済みであること。素の Play ストア版では、下の CA を入れても TLS が通らない。

---

## 0. 使うツール（このリポジトリ）

| ツール | 役割 |
| --- | --- |
| `tools/capture/run-capture.sh` | mitmdump を起動し、`newchatapi.com` 宛フローを `captures/raw/` に 1 フロー 1 JSON で保存。標準出力に `x-api-key`/`jwt-key` の有無を 1 行サマリ表示 |
| `tools/capture/mitm_capture.py` | 上の中身（mitmproxy アドオン）。環境変数 `SAVE_MEDIA_BYTES=1` で動画本体も保存 |
| `tools/capture/redact.py` | 生キャプチャを伏せ字にして `fixtures/` 用 JSON を生成。トークン・メール・電話・署名クエリは自動、名前/グループ/ID は `redact_map.json`（手で作成）で置換 |
| `tools/capture/decode_token.py` | `jwt-key` の値を展開し `exp`/`iat` を日時表示（チェック項目4用） |
| `tools/capture/redact_map.example.json` | 対応表のテンプレート。`redact_map.json` にコピーして実名を埋める（実ファイルは gitignore 済み） |

---

## 1. 環境準備

1. **mitmdump を起動**（この Mac で）：
   ```bash
   tools/capture/run-capture.sh
   ```
   起動ログにこの Mac の IP と待ち受けポート（既定 8080）が出る。

2. **端末のプロキシを向ける**：端末の Wi-Fi 設定でプロキシを `この Mac の IP:8080` に。Mac と端末は同じ LAN に置く。

3. **CA を端末に導入**：端末ブラウザで `http://mitm.it` を開き、Android 用証明書を入れる。パッチ版 setlog ならユーザー CA で TLS が通る。

4. **疎通確認**：端末で任意の HTTPS を開き、`run-capture.sh` の画面にフローのログ（`newchatapi.com` 以外は出ない設計）。setlog を一度開いてサマリ行が出れば成功。
   - 出ない場合：プロキシ設定／CA／パッチ版かどうかの順に疑う。`network_security_config` に `src="user"` が無いと、ここで必ず TLS ハンドシェイクが落ちる。

---

## 2. キャプチャの進め方

`run-capture.sh` を動かしたまま、**下のシナリオ順に** setlog を手で操作する。各操作の後に `captures/raw/` に出たファイル名（サマリ行の末尾）を、下のチェックリストの「capture」欄に控える。

操作の間隔はアプリ並みに。連打・自動化はしない（レート制限/bot 対策の観測が濁るため）。

### シナリオ（6操作＋補助）

1. **アプリ再起動 → 自動で走る初期リクエストを観察**：起動直後に `GET user/profile` や `GET collections` が自動で飛ぶか。→ 項目3・7
2. **（別端末が無ければスキップ可）ログアウト→メール OTP ログイン**：`auth/email/login/start` → コード入力 → `/verify`。レスポンスに `user.token` が入るか、`start` の間隔を詰めたときレート制限が出るか。→ 項目2
3. **グループ一覧を開く**：`GET collections`。ソロログ・DM が混ざるか、`type`/`roomType`/`participants` の実値。→ 項目1・7
4. **今日の日別ビューを開く**：`GET chat/{id}/messages?startTimeInterval=...`。`startTimeInterval` が現地04:00起点か、未投稿枠の表現、同一枠に複数投稿の並び。→ 項目8・11
5. **過去日・カレンダーを開く**：`GET collection/{id}/messageDaysInMonth?...`。`days` の中身、`timeZone` の有無で差が出るか。→ 項目9・10
6. **クリップを1本再生**：`media.newchatapi.com/<path>` への GET。無認証で200か、`Content-Type`/`Content-Length`/`Range`、1本のサイズ。→ 項目13〜17
7. **（任意）アップロード経路**：cutlog 側で投稿し `POST media/getUploadURL` を観察。→ 項目18

---

## 3. ヘッダー剥がし試験（最優先・項目1）

「`x-api-key`＋`jwt-key` だけで通るか」を確定する。`GET collections`（副作用が無く何度でも叩ける）を対象に、**ヘッダーを1つずつ外して再送**する。mitmproxy の `r`（リプレイ）か、下のように curl で生 URL を直叩きする。

```bash
# 値は captures/raw/ の collections フローから拾う（トークンは短命なので直近のものを）
API=https://api.newchatapi.com/collections
XKEY='<x-api-key>'
JWT='<jwt-key>'

# 全部入り（基準）
curl -s -o /dev/null -w '%{http_code}\n' "$API" -H "x-api-key: $XKEY" -H "jwt-key: $JWT" -H 'Content-Type: application/json'
# jwt-key を外す
curl -s -o /dev/null -w '%{http_code}\n' "$API" -H "x-api-key: $XKEY" -H 'Content-Type: application/json'
# x-api-key を外す
curl -s -o /dev/null -w '%{http_code}\n' "$API" -H "jwt-key: $JWT" -H 'Content-Type: application/json'
# Content-Type を外す / User-Agent 既定のまま 等
curl -s -o /dev/null -w '%{http_code}\n' "$API" -H "x-api-key: $XKEY" -H "jwt-key: $JWT"
```

| 外したヘッダー | 期待 | 実際のステータス | メモ |
| --- | --- | --- | --- |
| なし（基準） | 200 | | |
| `jwt-key` | 401 想定 | | 認証必須か |
| `x-api-key` | 403 想定 | | Gateway キー必須か |
| `Content-Type` | 200？ | | GET で必須か |
| `User-Agent`（空/任意値） | 200？ | | UA 検査の有無 |

結果を [api.md](api.md) 第3節の「外したときの結果／必須か」列に転記する。

---

## 4. 確認項目チェックリスト（static-analysis.md 第7節の実行版）

結果が出たら「結果」に実値、「capture」に `captures/raw/` のファイル名、反映先に書いたらチェック。

### 必須（方式 A＋A′ の成立条件）

- [ ] **1. `x-api-key`＋`jwt-key` だけで `/collections` が 200 か**（第3節の表） — 結果: `____` / capture: `____`
- [ ] **2. メール OTP を BFF から再現できるか**（`start` のレート制限・bot 対策・IP 制限、`verify` に `user.token`） — 結果: `____` / capture: `____`
- [ ] **3. `GET user/profile` が新 `token` を返すか**（返す=ローテーション/返さない=無期限） — 結果: `____` / capture: `____`
- [ ] **4. トークンの形式と寿命**（`decode_token.py --file <verify のcapture>` で `exp` を確認。exp 無しなら放置テストへ） — 結果: `____`
- [ ] **5. 復号済み mp4 を cutlog→BFF に送る経路**（`bw0.B()` の戻り `File`、`cacheDir/message-media/` の生成タイミング） — 結果: `____`
- [ ] **6. `keys[]` の自分宛の選び方**（`uid == 自分の userId` で確定か、別端末投稿の過去分の挙動） — 結果: `____` / capture: `____`

### データ形状の確定

- [ ] **7. `collections` にソロログが含まれるか**（`type`/`roomType`/`participants.length`、DM 混在） — 結果: `____` / capture: `____`
- [ ] **8. 1日分が24件を超えるか・同一枠複数投稿の並び**（`timestamp` 昇順か） — 結果: `____` / capture: `____`
- [ ] **9. `messageDaysInMonth` の `timeZone` 省略時の既定**（端末が Asia/Tokyo 以外で `days` がずれるか） — 結果: `____` / capture: `____`
- [ ] **10. `days` に 0 や 32 が混ざらないか** — 結果: `____`
- [ ] **11. 未投稿枠の表現**（空メッセージが入るか、欠落か） — 結果: `____`
- [ ] **12. `media[].permission` の値**（`SAVING` 以外＝`view_once` 系があるか） — 結果: `____`

### 動画の実測（api.md 4.6 の表を埋める）

- [ ] **13. `media.newchatapi.com/<path>` を無認証で GET できるか**（200/暗号文 or 403） — 結果: `____` / capture: `____`
- [ ] **14. `Range: bytes=0-1023` が通るか** — 結果: `____`
- [ ] **15. 1本のサイズ・解像度・ビットレート**（自分/他人で差） — 結果: `____`
- [ ] **16. `media[].dimensions` が常に入るか** — 結果: `____`
- [ ] **17. `Content-Type`/`Content-Length`/`ETag`/`Cache-Control`** — 結果: `____`
- [ ] **18. `POST media/getUploadURL` の `uploadUrl` 形式**（S3 presigned か、有効期限） — 結果: `____` / capture: `____`

### その他

- [ ] **19. `x-api-key` のローテーション有無**（アプリ更新で変わるか。今は定数記録で十分） — 結果: `____`
- [ ] **20. WebSocket `wss://ws.newchatapi.com/` の必要性**（ポーリングで新着が取れるか） — 結果: `____`
- [ ] **21. `account_locked` 以外の 403 の意味**（`auth/diagnostics` の `authMethod` と突き合わせ） — 結果: `____`

---

## 5. fixtures 化（伏せ字）

1. **対応表を作る**：`cp tools/capture/redact_map.example.json tools/capture/redact_map.json` して、生キャプチャに出た実名・グループ名・実 UUID を左に、`member-1`/`group-1`/ダミー UUID を右に埋める。ファイル間で同じ人は同じ番号。
2. **伏せ字にして保存**（ファイル名規約は [fixtures/README.md](../fixtures/README.md)）：
   ```bash
   python3 tools/capture/redact.py captures/raw/00X_..._GET_collections.json -o fixtures/groups.list.json
   python3 tools/capture/redact.py captures/raw/00X_..._GET_messages.json    -o fixtures/days.today.json
   # …6操作ぶん
   ```
3. **コミット前チェック**（fixtures/README.md の grep）：
   ```bash
   grep -rniE 'bearer|eyJ[a-zA-Z0-9_-]{10,}|token"\s*:\s*"[^R]|@[a-z0-9-]+\.[a-z]{2,}|\+81|0[789]0[0-9]{8}' fixtures/
   ```
   何も出なければ OK。出たら対応表か `redact.py` の正規表現を足す。

> `redact.py` が自動で潰すのはトークン・メール・電話・署名クエリと、headers ブロックの `jwt-key`/`x-api-key`/`cookie` だけ。**表示名・グループ名・ID は対応表が無いと素通りする**ので、必ず grep で最終確認する。

---

## 6. 完了条件と反映

- [ ] 6操作すべてのレスポンスを `fixtures/` に伏せ字で保存（grep クリーン）
- [ ] [api.md](api.md) の各操作「フィクスチャ：（未取得）」を実ファイル名に更新し、「状態＝静的」を「動的」に
- [ ] [api.md](api.md) 第3節ヘッダー表の「外したときの結果／必須か」を実測で埋める
- [ ] [api.md](api.md) 第5節「判定」の脚注（「動的解析で確認できたら確定」）を、確定の記述に書き換える
- [ ] `docs/design.md` の各「解析結果（2026-11-18、静的解析）」で動的確認待ちだった箇所を更新
- [ ] fixtures から zod スキーマを起こす（`lib/setlog/schema.ts`。フェーズ1 の入口）

これが揃えばフェーズ0 完了。設計書13章のチェックボックスを閉じ、フェーズ1（MVP）の `lib/setlog` 実装に進む。
