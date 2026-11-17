# fixtures

setlog API の実レスポンスを伏せ字にしたもの。テストと zod スキーマの検証に使う。

生のキャプチャは `captures/`（git 管理外）に置き、下のルールで伏せ字にしてからここへコピーする。

## ファイル名

`{操作}.{状況}.json`

例：`groups.list.json`、`days.today.json`、`days.past.json`、`calendar.month.json`、`clips.media.json`、`auth.refresh.json`、`error.401.json`

## 伏せ字ルール

コミット前に、以下がすべて置き換わっていることを確認する。

| 対象 | 置き換え方 |
| --- | --- |
| アクセストークン、リフレッシュトークン、署名、Cookie | `REDACTED` |
| 電話番号、メールアドレス | `REDACTED` |
| 自分と友達の表示名・ユーザー名 | `member-1`、`member-2` …（ファイル間で同じ人は同じ番号） |
| グループ名 | `group-1`、`group-2` … |
| ユーザー ID、グループ ID、クリップ ID | 形を保ったダミー値（UUID なら UUID、数値なら数値）。参照関係は保つ |
| 動画・サムネイル・アバターの URL | ホスト名とパスの形だけ残し、ID と署名クエリを `REDACTED` に |
| 端末 ID、広告 ID | `REDACTED` |
| 日時 | そのままでよい（形とタイムゾーンの検証に必要）。気になる場合は日付だけずらす |

フィールドの有無、型、配列の長さ、null の出方は変えない。スキーマの検証が目的なので、構造は生のまま残す。

## コミット前の確認

```bash
grep -rniE 'bearer|eyJ[a-zA-Z0-9_-]{10,}|token"\s*:\s*"[^R]|@[a-z0-9-]+\.[a-z]{2,}|\+81|0[789]0[0-9]{8}' fixtures/
```

何も出なければよい。`eyJ` は JWT の先頭。
