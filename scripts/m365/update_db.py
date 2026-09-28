#!/usr/bin/env python3
"""
读取 ~/.9router/m365-token.json，通过 9router HTTP API 更新 m365-copilot 连接。

不再直接写 SQLite（与容器内 better-sqlite3 并发写会损坏数据库）。

用法：
  python3 update_db.py
  BASE_URL=http://127.0.0.1:20128 DASHBOARD_PASSWORD=xxx python3 update_db.py
"""
import base64, hashlib, http.cookiejar, json, os, sys, urllib.request, urllib.error
from datetime import datetime, timezone
from pathlib import Path

PROVIDER = "m365-copilot"
TOKEN_DIR = Path.home() / ".9router"
DEFAULT_BASE_URL = "http://127.0.0.1:20128"
DEFAULT_PASSWORD = "123456"
CLI_TOKEN_SALT = "9r-cli-auth"


def decode_jwt_payload(token):
    try:
        parts = token.split(".")
        seg = parts[1] + "=" * (-len(parts[1]) % 4)
        return json.loads(base64.urlsafe_b64decode(seg))
    except Exception:
        return {}


def compute_cli_token(data_dir):
    """9Router CLI token: sha256(machineId + salt + cliSecret)[:16]，与 cli/src/cli/api/client.js 一致。"""
    try:
        raw = (Path(data_dir) / "machine-id").read_text(encoding="utf-8").strip()
        secret = (Path(data_dir) / "auth" / "cli-secret").read_text(encoding="utf-8").strip()
        return hashlib.sha256((raw + CLI_TOKEN_SALT + secret).encode()).hexdigest()[:16]
    except Exception:
        return None


class ApiClient:
    def __init__(self, base_url, password, cli_token=None):
        self.base_url = base_url.rstrip("/")
        self.password = password
        self.cli_token = cli_token
        self.cookiejar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.cookiejar)
        )

    def _request(self, method, path, payload=None):
        url = f"{self.base_url}{path}"
        data = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        if self.cli_token:
            req.add_header("x-9r-cli-token", self.cli_token)
        resp = self.opener.open(req, timeout=15)
        body = resp.read().decode()
        return resp.status, json.loads(body) if body else {}

    def login(self):
        status, body = self._request("POST", "/api/auth/login", {"password": self.password})
        if status != 200 or not body.get("success"):
            raise RuntimeError(f"登录失败: {body.get('error') or body}")
        return True

    def list_connections(self):
        status, body = self._request("GET", "/api/providers")
        if status != 200:
            raise RuntimeError(f"获取连接列表失败: {body}")
        return body.get("connections", [])

    def update_connection(self, conn_id, token):
        payload = {
            "apiKey": token,
            "testStatus": "active",
            "isActive": True,
            "lastError": None,
            "lastErrorAt": None,
        }
        status, body = self._request("PUT", f"/api/providers/{conn_id}", payload)
        if status != 200:
            raise RuntimeError(f"更新连接失败: {body.get('error') or body}")
        return body

    def create_connection(self, token, name):
        payload = {
            "provider": PROVIDER,
            "apiKey": token,
            "name": name,
            "testStatus": "active",
        }
        status, body = self._request("POST", "/api/providers", payload)
        if status != 200 and status != 201:
            raise RuntimeError(f"创建连接失败: {body.get('error') or body}")
        return body


def main():
    data_dir = os.environ.get("DATA_DIR", str(TOKEN_DIR))
    token_file = Path(data_dir) / "m365-token.json"
    base_url = os.environ.get("BASE_URL") or DEFAULT_BASE_URL
    password = os.environ.get("DASHBOARD_PASSWORD") or DEFAULT_PASSWORD

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

    try:
        cli_token = compute_cli_token(data_dir)
        client = ApiClient(base_url, password, cli_token)
        try:
            connections = client.list_connections()
            auth_mode = f"CLI token ({cli_token[:4]}...)"
        except urllib.error.HTTPError:
            # CLI token 不可用 → 密码登录
            client.login()
            auth_mode = "dashboard 密码"
            connections = client.list_connections()
        print(f"[DB] 🔑 认证方式: {auth_mode}")
        existing = next((c for c in connections if c.get("provider") == PROVIDER), None)
        if existing:
            conn_id = existing["id"]
            client.update_connection(conn_id, token)
            print(f"[DB] ✅ 已更新 m365-copilot 连接 (id={conn_id[:8]}...)")
        else:
            client.create_connection(token, f"M365 ({upn})")
            print("[DB] ✅ 已创建新 m365-copilot 连接")
        print(f"[DB] ✅ 完成 (用户: {upn})")
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode()
        except Exception:
            pass
        print(f"[DB] ❌ HTTP {e.code}: {detail or e.reason}")
        if e.code in (401, 403):
            print(f"    密码可通过 DASHBOARD_PASSWORD 环境变量指定")
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"[DB] ❌ 无法连接 9router ({base_url}): {e}")
        print(f"    确认服务已启动，或通过 BASE_URL 指定地址")
        sys.exit(1)
    except RuntimeError as e:
        print(f"[DB] ❌ {e}")
        print(f"    密码可通过 DASHBOARD_PASSWORD 环境变量指定")
        sys.exit(1)


if __name__ == "__main__":
    main()
