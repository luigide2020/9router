#!/usr/bin/env python3
"""
读取 ~/.9router/m365-token.json，写入 SQLite providerConnections 表。

用法：
  python3 update_db.py
  DATA_DIR=/app/data python3 update_db.py
"""
import base64, json, os, sqlite3, sys, uuid
from datetime import datetime, timezone
from pathlib import Path

PROVIDER = "m365-copilot"
AUTH_TYPE = "cookie"
TOKEN_DIR = Path.home() / ".9router"


def get_db_path():
    data_dir = os.environ.get("DATA_DIR", str(TOKEN_DIR))
    return Path(data_dir) / "db" / "data.sqlite"


def iso_from_ts(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat() if ts else None


def decode_jwt_payload(token):
    try:
        parts = token.split(".")
        seg = parts[1] + "=" * (-len(parts[1]) % 4)
        return json.loads(base64.urlsafe_b64decode(seg))
    except Exception:
        return {}


def main():
    data_dir = os.environ.get("DATA_DIR", str(TOKEN_DIR))
    token_file = Path(data_dir) / "m365-token.json"

    if not token_file.exists():
        print(f"[DB] ❌ token 文件不存在: {token_file}")
        sys.exit(1)

    try:
        td = json.loads(token_file.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"[DB] ❌ 读取 token 文件失败: {e}")
        sys.exit(1)

    token = td.get("accessToken", "")
    if not token:
        print("[DB] ❌ token 文件中没有 accessToken")
        sys.exit(1)

    claims = decode_jwt_payload(token)
    upn = claims.get("upn") or claims.get("preferred_username") or td.get("userPrincipalName", "unknown")

    db_path = get_db_path()
    if not db_path.exists():
        print(f"[DB] ❌ 数据库不存在: {db_path}")
        print(f"    请先启动 9router 初始化数据库，或设置 DATA_DIR")
        sys.exit(1)

    now = datetime.now(tz=timezone.utc).isoformat()
    data_obj = {"apiKey": token, "testStatus": "active"}
    if exp := iso_from_ts(claims.get("exp")):
        data_obj["expiresAt"] = exp

    try:
        with sqlite3.connect(str(db_path), timeout=10) as conn:
            conn.execute("PRAGMA busy_timeout = 5000")
            row = conn.execute(
                "SELECT id, data FROM providerConnections WHERE provider = ? LIMIT 1",
                (PROVIDER,),
            ).fetchone()
            if row:
                row_id, raw_data = row
                existing = json.loads(raw_data) if raw_data else {}
                existing.update(data_obj)
                conn.execute(
                    "UPDATE providerConnections SET data = ?, updatedAt = ?, isActive = 1 WHERE id = ?",
                    (json.dumps(existing), now, row_id),
                )
                print(f"[DB] ✅ 已更新 m365-copilot 连接 (id={row_id[:8]}...)")
            else:
                new_id = str(uuid.uuid4())
                conn.execute(
                    """INSERT INTO providerConnections
                       (id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
                       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)""",
                    (new_id, PROVIDER, AUTH_TYPE, f"M365 ({upn})", upn, 1, json.dumps(data_obj), now, now),
                )
                print(f"[DB] ✅ 已创建新 m365-copilot 连接 (id={new_id[:8]}...)")
        print(f"[DB] ✅ 完成 (用户: {upn})")
    except sqlite3.Error as e:
        print(f"[DB] ❌ SQLite 错误: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
