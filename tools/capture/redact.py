#!/usr/bin/env python3
"""captures/raw/ の生キャプチャを伏せ字にして fixtures/ 用の JSON を作る補助。

fixtures/README.md の伏せ字ルールに沿って、決め打ちできる置換（トークン・
メール・電話番号・署名クエリ）は自動で行う。表示名・グループ名・ID など
「対応表が要る」ものは redact_map.json を読んで置換する（手で埋める）。

構造・型・配列長・null の出方は変えない（スキーマ検証が目的なので）。

使い方:
    # 生キャプチャのレスポンス本体を伏せ字にして標準出力へ
    python3 tools/capture/redact.py captures/raw/003_..._GET_collections.json

    # fixtures に保存
    python3 tools/capture/redact.py captures/raw/003_..._GET_collections.json \\
        -o fixtures/groups.list.json

    # リクエスト側も含めて丸ごと伏せ字にしたいとき
    python3 tools/capture/redact.py <file> --whole

対応表 (tools/capture/redact_map.json、任意):
    {
      "literal": { "実名そのまま": "member-1", "グループ名": "group-1" },
      "ids":     { "実UUID": "00000000-0000-4000-8000-000000000001" }
    }
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

MAP_PATH = Path(__file__).resolve().parent / "redact_map.json"

# 決め打ちの正規表現置換（値ごと REDACTED に潰す）
JWT_RE = re.compile(r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+")
BEARER_RE = re.compile(r"(?i)bearer\s+[A-Za-z0-9._-]+")
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
PHONE_RE = re.compile(r"(?:\+81|0)[0-9]{9,10}")
# media URL の署名クエリ（?...&sig=...&token=...）。ホストとパスは残す。
SIG_QUERY_RE = re.compile(r"([?&](?:sig|signature|token|key|expires|x-amz-[a-z-]+)=)[^&\s\"]+", re.IGNORECASE)

# ヘッダーのうち常に潰すもの
SECRET_HEADERS = {"jwt-key", "x-api-key", "authorization", "cookie", "set-cookie"}

# キー名で常に潰すフィールド（値の形に関係なく REDACTED にする）
# 構造・型は保つため文字列 "REDACTED" に置換する。
SECRET_FIELDS = {
    "devicetoken", "pushtoken", "fcmtoken", "apnstoken", "token",
    "pin", "code",
}


def load_map() -> dict:
    if MAP_PATH.exists():
        return json.loads(MAP_PATH.read_text(encoding="utf-8"))
    return {}


def redact_string(s: str, mapping: dict) -> str:
    # 対応表（完全一致 → 部分一致）を先に当てる
    for table in ("literal", "ids"):
        for src, dst in mapping.get(table, {}).items():
            if s == src:
                return dst
    out = s
    for table in ("literal", "ids"):
        for src, dst in mapping.get(table, {}).items():
            if src and src in out:
                out = out.replace(src, dst)
    # 決め打ち正規表現
    out = JWT_RE.sub("REDACTED", out)
    out = BEARER_RE.sub("Bearer REDACTED", out)
    out = EMAIL_RE.sub("REDACTED", out)
    out = PHONE_RE.sub("REDACTED", out)
    out = SIG_QUERY_RE.sub(r"\1REDACTED", out)
    return out


def walk(node, mapping: dict, in_headers: bool = False):
    if isinstance(node, dict):
        result = {}
        for k, v in node.items():
            # headers ブロック内の秘匿ヘッダーは値ごと潰す
            if in_headers and isinstance(k, str) and k.lower() in SECRET_HEADERS:
                result[k] = "REDACTED"
                continue
            # キー名が機密フィールドなら、値の中身に関係なく潰す
            if isinstance(k, str) and k.lower() in SECRET_FIELDS and isinstance(v, str) and v:
                result[k] = "REDACTED"
                continue
            # "headers" キーの下に降りるときだけ in_headers を立てる
            child_in_headers = isinstance(k, str) and k.lower() == "headers"
            result[k] = walk(v, mapping, in_headers=child_in_headers)
        return result
    if isinstance(node, list):
        return [walk(v, mapping, in_headers) for v in node]
    if isinstance(node, str):
        return redact_string(node, mapping)
    return node


def main() -> int:
    ap = argparse.ArgumentParser(description="生キャプチャを伏せ字にして fixtures 用 JSON を作る")
    ap.add_argument("capture", help="captures/raw/ の JSON ファイル")
    ap.add_argument("-o", "--output", help="出力先（省略時は標準出力）")
    ap.add_argument("--whole", action="store_true", help="レスポンス本体だけでなく記録全体を伏せ字にする")
    args = ap.parse_args()

    mapping = load_map()
    record = json.loads(Path(args.capture).read_text(encoding="utf-8"))

    if args.whole:
        redacted = walk(record, mapping)
    else:
        body = record.get("response", {}).get("body")
        if body is None:
            print("response.body が JSON として記録されていません（--whole で全体を出せます）", file=sys.stderr)
            return 1
        redacted = walk(body, mapping)

    text = json.dumps(redacted, ensure_ascii=False, indent=2)
    if args.output:
        Path(args.output).write_text(text + "\n", encoding="utf-8")
        print(f"書き出し: {args.output}", file=sys.stderr)
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
