#!/usr/bin/env python3
"""
将本地 ~/.9router/m365-token.json 同步到远程 9router 服务。

两步操作：
  1. 登录远程 dashboard 获取 auth_token cookie
  2. 调用 /api/oauth/m365-copilot 保存 token（远程自动 update_db）

用法：
  python scripts/m365/sync_remote.py
  python scripts/m365/sync_remote.py --remote-url http://xxx:20128 --password a1s2d3f4
  python scripts/m365/sync_remote.py --token-file /path/to/token.json

环境变量：
  REMOTE_URL       远程地址（默认 http://jiaguwen.plain.ccwu.cc:20128）
  REMOTE_PASSWORD  dashboard 密码
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

DEFAULT_REMOTE = "http://jiaguwen.plain.ccwu.cc:20128"
TOKEN_FILE = Path.home() / ".9router" / "m365-token.json"


def load_token(token_file):
    """从本地 token 文件读取 accessToken。"""
    if not token_file.exists():
        print(f"[ERROR] token 文件不存在: {token_file}")
        print(f"请先运行 login.py 抓取 token")
        return None
    try:
        data = json.loads(token_file.read_text(encoding="utf-8"))
        token = data.get("accessToken", "")
        if not token:
            print(f"[ERROR] token 文件中没有 accessToken: {token_file}")
            return None
        upn = data.get("userPrincipalName", "unknown")
        exp = data.get("expiresAt", "unknown")
        print(f"[TOKEN] 读取自 {token_file}")
        print(f"  用户: {upn}  过期: {exp}")
        return token
    except Exception as e:
        print(f"[ERROR] 读取 token 文件失败: {e}")
        return None


def sync_to_remote(token, remote_url, password):
    """用 curl 登录远程并推送 token。"""
    base = remote_url.rstrip("/")

    if not password:
        print("[ERROR] 请提供远程 dashboard 密码（--password 或 REMOTE_PASSWORD 环境变量）")
        return False

    # === 第一步：登录 ===
    print(f"\n[STEP 1] 登录远程 {remote_url} ...")
    login_result = subprocess.run(
        [
            "curl", "-s", "-S", "-c", "-",
            "-X", "POST", f"{base}/api/auth/login",
            "-H", "Content-Type: application/json",
            "-d", json.dumps({"password": password}),
            "--max-time", "15",
        ],
        capture_output=True, text=True,
    )

    if login_result.returncode != 0:
        print(f"[ERROR] curl 登录失败 (exit {login_result.returncode}):")
        print(f"  stderr: {login_result.stderr}")
        return False

    # 解析 curl -c - 输出的 cookie jar（格式: domain\tflag\tpath\tsecure\texpiry\tname\tvalue）
    auth_cookie = None
    for line in login_result.stdout.strip().split("\n"):
        parts = line.split("\t")
        if len(parts) >= 7 and parts[5] == "auth_token":
            auth_cookie = parts[6]
            break

    if not auth_cookie:
        print(f"[ERROR] 登录成功但未获取到 auth_token cookie")
        print(f"  curl 输出: {login_result.stdout[:500]}")
        return False

    print(f"[STEP 1] ✅ 登录成功，已获取 auth_token")

    # === 第二步：推送 token ===
    print(f"\n[STEP 2] 推送 token 到 {remote_url} ...")
    push_result = subprocess.run(
        [
            "curl", "-s", "-S", "-w", "\n%{http_code}",
            "-X", "POST", f"{base}/api/oauth/m365-copilot",
            "-H", "Content-Type: application/json",
            "-H", f"Cookie: auth_token={auth_cookie}",
            "-d", json.dumps({"action": "save", "accessToken": token}),
            "--max-time", "30",
        ],
        capture_output=True, text=True,
    )

    if push_result.returncode != 0:
        print(f"[ERROR] curl 推送失败 (exit {push_result.returncode}):")
        print(f"  stderr: {push_result.stderr}")
        return False

    # 分离 body 和 status code
    lines = push_result.stdout.strip().rsplit("\n", 1)
    if len(lines) == 2:
        body_str, status_str = lines
    else:
        body_str, status_str = push_result.stdout, "0"

    try:
        body = json.loads(body_str)
    except json.JSONDecodeError:
        print(f"[ERROR] 推送响应不是有效 JSON: {body_str[:300]}")
        return False

    status_code = int(status_str) if status_str.isdigit() else 0

    if status_code == 200 and body.get("success"):
        upn = body.get("userPrincipalName", "unknown")
        exp = body.get("expiresAt", "unknown")
        print(f"[STEP 2] ✅ 已推送到 {remote_url}")
        print(f"  用户: {upn}  过期: {exp}")
        return True
    else:
        err = body.get("error", body_str[:200])
        print(f"[STEP 2] ❌ 推送失败 (HTTP {status_code}): {err}")
        return False


def main():
    ap = argparse.ArgumentParser(
        description="将本地 M365 token 同步到远程 9router 服务"
    )
    ap.add_argument("--remote-url", default=None,
                    help=f"远程地址（默认从 REMOTE_URL 环境变量或 {DEFAULT_REMOTE}）")
    ap.add_argument("--password", default=None,
                    help="远程 dashboard 密码（也可通过 REMOTE_PASSWORD 环境变量）")
    ap.add_argument("--token-file", default=None, type=Path,
                    help=f"token 文件路径（默认 {TOKEN_FILE}）")
    args = ap.parse_args()

    remote_url = args.remote_url or os.environ.get("REMOTE_URL", DEFAULT_REMOTE)
    password = args.password or os.environ.get("REMOTE_PASSWORD", "")
    token_file = args.token_file or TOKEN_FILE

    print(f"远程地址: {remote_url}")
    print(f"Token 文件: {token_file}")

    token = load_token(token_file)
    if not token:
        sys.exit(1)

    ok = sync_to_remote(token, remote_url, password)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
