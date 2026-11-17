"""setlog 動的解析用の mitmproxy アドオン。

newchatapi.com 宛のフローだけを拾い、生のリクエスト/レスポンスを
captures/raw/ に 1 フロー 1 ファイルで保存する。標準出力には必須ヘッダー
(x-api-key / jwt-key) の有無を含む 1 行サマリを出す。

captures/ は .gitignore で除外されているので、ここに実トークン・実名が
残ってよい。伏せ字にして fixtures/ へ写すのは redact.py の仕事（別ステップ）。

使い方:
    mitmdump -s tools/capture/mitm_capture.py --listen-port 8080

環境変数:
    CAPTURE_DIR        保存先ディレクトリ (既定: captures/raw)
    CAPTURE_HOSTS      対象ホストのカンマ区切り (既定: newchatapi.com)
                       部分一致。media/api/ws/execute-api をまとめて拾う
    SAVE_MEDIA_BYTES   "1" のとき media.* の本体バイト列も保存 (既定: 無効)
                       動画は E2EE 暗号文かつ巨大なので既定では保存しない
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

from mitmproxy import http

# --- 設定 ---------------------------------------------------------------

CAPTURE_DIR = Path(os.environ.get("CAPTURE_DIR", "captures/raw"))
HOSTS = [h.strip() for h in os.environ.get("CAPTURE_HOSTS", "newchatapi.com").split(",") if h.strip()]
SAVE_MEDIA_BYTES = os.environ.get("SAVE_MEDIA_BYTES", "") == "1"

# 動的解析で注目するヘッダー（有無と長さを記録する）
WATCH_HEADERS = ["x-api-key", "jwt-key", "authorization", "user-agent", "content-type"]

_seq = 0


# --- ユーティリティ -----------------------------------------------------


def _is_target(host: str) -> bool:
    return any(h in host for h in HOSTS)


def _safe_path(path: str) -> str:
    """URL パスをファイル名の一部に使える形へ。クエリは落とす。"""
    path = path.split("?", 1)[0].strip("/")
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", path) or "root"
    return slug[:80]


def _maybe_json(raw: bytes, content_type: str):
    """JSON ならパースして返す。無理なら None。"""
    if "json" not in content_type.lower():
        return None
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None


def _headers_dict(headers) -> dict:
    # 同名ヘッダーは最後の値でまとめる（解析用途では十分）
    return {k: v for k, v in headers.items()}


def _watch_summary(req_headers: dict) -> str:
    parts = []
    for name in WATCH_HEADERS:
        val = None
        for k, v in req_headers.items():
            if k.lower() == name:
                val = v
                break
        if val is None:
            parts.append(f"{name}=-")
        else:
            parts.append(f"{name}=✓({len(val)})")
    return " ".join(parts)


# --- mitmproxy フック ---------------------------------------------------


def load(loader):
    CAPTURE_DIR.mkdir(parents=True, exist_ok=True)
    print(f"[capture] 保存先: {CAPTURE_DIR.resolve()}")
    print(f"[capture] 対象ホスト（部分一致）: {', '.join(HOSTS)}")
    print(f"[capture] media 本体バイト保存: {'ON' if SAVE_MEDIA_BYTES else 'OFF'}")


def response(flow: http.HTTPFlow) -> None:
    host = flow.request.pretty_host
    if not _is_target(host):
        return

    global _seq
    _seq += 1
    seq = _seq

    req = flow.request
    resp = flow.response
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")

    req_headers = _headers_dict(req.headers)
    resp_headers = _headers_dict(resp.headers)
    resp_ctype = resp_headers.get("content-type", resp_headers.get("Content-Type", ""))
    is_media = "media." in host

    record = {
        "seq": seq,
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "request": {
            "method": req.method,
            "url": req.pretty_url,
            "host": host,
            "path": req.path.split("?", 1)[0],
            "query": dict(req.query),
            "headers": req_headers,
            "body": None,
            "bodyBytes": len(req.raw_content or b""),
        },
        "response": {
            "status": resp.status_code,
            "headers": resp_headers,
            "contentType": resp_ctype,
            "body": None,
            "bodyBytes": len(resp.raw_content or b""),
        },
    }

    # リクエストボディ（JSON なら構造ごと、そうでなければテキスト先頭だけ）
    req_body_json = _maybe_json(req.raw_content or b"", req_headers.get("content-type", req_headers.get("Content-Type", "")))
    if req_body_json is not None:
        record["request"]["body"] = req_body_json

    # レスポンスボディ
    base = f"{seq:03d}_{ts}_{req.method}_{_safe_path(req.path)}"
    if is_media:
        # 動画・サムネは暗号文かつ巨大。既定ではメタのみ。
        if SAVE_MEDIA_BYTES and resp.raw_content:
            media_dir = CAPTURE_DIR / "media"
            media_dir.mkdir(parents=True, exist_ok=True)
            (media_dir / f"{base}.bin").write_bytes(resp.raw_content)
            record["response"]["savedBytesTo"] = str((media_dir / f"{base}.bin"))
    else:
        resp_body_json = _maybe_json(resp.raw_content or b"", resp_ctype)
        if resp_body_json is not None:
            record["response"]["body"] = resp_body_json
        else:
            # JSON でないテキスト系は先頭だけ記録（バイナリは記録しない）
            raw = resp.raw_content or b""
            try:
                record["response"]["bodyTextHead"] = raw[:2000].decode("utf-8")
            except UnicodeDecodeError:
                record["response"]["bodyTextHead"] = f"<binary {len(raw)} bytes>"

    out = CAPTURE_DIR / f"{base}.json"
    out.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")

    print(
        f"[{seq:03d}] {resp.status_code} {req.method} {host}{record['request']['path']} "
        f"req={record['request']['bodyBytes']}B resp={record['response']['bodyBytes']}B | "
        f"{_watch_summary(req_headers)} -> {out.name}"
    )
