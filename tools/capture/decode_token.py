#!/usr/bin/env python3
"""jwt-key の値を調べる補助。JWT なら header/payload を展開し、exp/iat を
人間可読な日時に直して表示する。不透明トークン（JWT でない）ならその旨を出す。

動的解析チェック項目 4「トークンの形式と寿命」用。有効期限が exp で分かれば
放置テストの前に寿命が読める。

使い方:
    python3 tools/capture/decode_token.py <token>
    python3 tools/capture/decode_token.py --file captures/raw/00x_..._verify.json
      （--file は capture JSON から user.token を拾って調べる）
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
from datetime import datetime, timezone
from pathlib import Path


def b64url_decode(seg: str) -> bytes:
    pad = "=" * (-len(seg) % 4)
    return base64.urlsafe_b64decode(seg + pad)


def find_token(obj):
    """capture JSON から user.token らしきものを再帰で探す。"""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == "token" and isinstance(v, str):
                return v
            found = find_token(v)
            if found:
                return found
    elif isinstance(obj, list):
        for v in obj:
            found = find_token(v)
            if found:
                return found
    return None


def human_ts(val) -> str:
    try:
        return datetime.fromtimestamp(int(val), tz=timezone.utc).isoformat()
    except (ValueError, OverflowError, OSError):
        return "(日時として解釈不可)"


def inspect(token: str) -> None:
    parts = token.split(".")
    if len(parts) != 3:
        print("JWT 形式ではありません（ドット区切り 3 分割でない）= 不透明トークンの可能性。")
        print(f"長さ: {len(token)} 文字")
        return
    try:
        header = json.loads(b64url_decode(parts[0]))
        payload = json.loads(b64url_decode(parts[1]))
    except (ValueError, json.JSONDecodeError) as e:
        print(f"JWT 風だがデコードに失敗: {e}")
        print(f"長さ: {len(token)} 文字")
        return

    print("=== header ===")
    print(json.dumps(header, ensure_ascii=False, indent=2))
    print("=== payload ===")
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    print("=== 寿命 ===")
    if "exp" in payload:
        print(f"exp: {payload['exp']} = {human_ts(payload['exp'])}")
    else:
        print("exp なし → トークン自体に期限が埋まっていない（サーバー側で判定 or 無期限）")
    if "iat" in payload:
        print(f"iat: {payload['iat']} = {human_ts(payload['iat'])}")
    if "exp" in payload and "iat" in payload:
        span = int(payload["exp"]) - int(payload["iat"])
        print(f"有効期間: {span} 秒 = 約 {span / 3600:.1f} 時間 / {span / 86400:.1f} 日")


def main() -> int:
    ap = argparse.ArgumentParser(description="jwt-key トークンを調べる")
    ap.add_argument("token", nargs="?", help="トークン文字列")
    ap.add_argument("--file", help="capture JSON から user.token を拾う")
    args = ap.parse_args()

    if args.file:
        obj = json.loads(Path(args.file).read_text(encoding="utf-8"))
        token = find_token(obj)
        if not token:
            print("capture JSON に token が見つかりません", file=sys.stderr)
            return 1
    elif args.token:
        token = args.token
    else:
        ap.print_help()
        return 2

    inspect(token)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
