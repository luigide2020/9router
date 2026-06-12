"""
M365 Copilot 登录 + access_token 抓取脚本

原理：拦截页面 HTTP 请求，从 Authorization: Bearer 头中提取 access_token。
      比解析 localStorage 更可靠（MSAL v4 会加密存储）。

用法:
    export M365_EMAIL="your@email.com"
    export M365_PASSWORD="your_password"
    uv run scripts/m365/login.py                # 登录 + 抓 token
    uv run scripts/m365/login.py --sniff-only   # 复用缓存登录态
"""

import argparse
import base64
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright, TimeoutError as PwTimeout
except ImportError:
    print("❌ playwright 未安装。运行: uv add playwright && uv run playwright install chromium")
    sys.exit(1)

# ── 配置 ──────────────────────────────────────────────────────────────────────
CHAT_URL = "https://m365.cloud.microsoft/chat"
USER_DATA_DIR = str(Path(__file__).parent / ".browser_profile")
TOKEN_DIR = Path.home() / ".9router"
TOKEN_FILE = TOKEN_DIR / "m365-token.json"

# 我们关心的 token 目标 host（按优先级）
TARGET_HOSTS = [
    "substrate.office.com",  # Copilot WebSocket 用的 token
]


def decode_jwt_payload(token: str) -> dict | None:
    """解码 JWT payload（不验证签名）"""
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return None
        payload = parts[1]
        padding = 4 - len(payload) % 4
        if padding != 4:
            payload += "=" * padding
        return json.loads(base64.urlsafe_b64decode(payload))
    except Exception:
        return None


def is_logged_in(page):
    """检查是否已登录"""
    return page.locator('input[type="email"]').count() == 0


def do_login(page, email, password):
    """执行登录流程"""
    print("[LOGIN] 输入邮箱...")
    page.fill('input[type="email"]', email)
    page.click('input[type="submit"]')

    print("[LOGIN] 等待密码框...")
    page.wait_for_selector('input[type="password"]', timeout=15000)
    page.fill('input[type="password"]', password)
    page.click('input[type="submit"]')

    # "保持登录?" 弹窗
    try:
        page.wait_for_selector('#idSIButton9', timeout=8000)
        page.click('#idSIButton9')
    except PwTimeout:
        pass

    print("[LOGIN] 等待跳转...")
    page.wait_for_url("**m365.cloud.microsoft/**", timeout=30000)
    print("[LOGIN] ✅ 登录成功")


def save_token(token: str) -> None:
    """保存 access token 到文件"""
    TOKEN_DIR.mkdir(parents=True, exist_ok=True)

    claims = decode_jwt_payload(token) or {}
    exp = claims.get("exp")
    expires_at = datetime.fromtimestamp(exp, tz=timezone.utc).isoformat() if exp else "unknown"
    user = claims.get("upn") or claims.get("preferred_username") or "unknown"

    data = {
        "accessToken": token,
        "extractedAt": datetime.now(tz=timezone.utc).isoformat(),
        "expiresAt": expires_at,
        "userPrincipalName": user,
        "tenantId": claims.get("tid", "unknown"),
        "objectId": claims.get("oid", "unknown"),
        "clientId": claims.get("appid") or claims.get("azp") or "unknown",
    }

    TOKEN_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False))
    print(f"\n[TOKEN] ✅ 已保存到 {TOKEN_FILE}")
    print(f"  用户: {user}")
    print(f"  过期: {expires_at}")
    print(f"  Client: {data['clientId']}")

    if exp and exp < time.time():
        print("[TOKEN] ⚠️  注意：token 已过期！")
    elif exp:
        remaining = exp - time.time()
        print(f"  剩余: {remaining/60:.0f} 分钟")


def main():
    parser = argparse.ArgumentParser(description="M365 Copilot 登录 + access_token 抓取")
    parser.add_argument("--sniff-only", action="store_true", help="跳过登录，直接抓 token（需已有登录态）")
    parser.add_argument("--headless", action="store_true", help="无头模式")
    parser.add_argument("--timeout", type=int, default=60, help="等待 token 的超时秒数（默认 60）")
    args = parser.parse_args()

    email = os.environ.get("M365_EMAIL", "")
    password = os.environ.get("M365_PASSWORD", "")

    if not args.sniff_only and (not email or not password):
        print("[ERROR] 请设置环境变量 M365_EMAIL 和 M365_PASSWORD")
        sys.exit(1)

    # ── 抓取状态 ──────────────────────────────────────────────────────────────
    captured_tokens: dict[str, str] = {}   # host -> token
    substrate_token: str | None = None

    def on_request(req):
        nonlocal substrate_token
        auth = req.headers.get("authorization", "")
        if not auth.lower().startswith("bearer "):
            return
        token = auth[7:]
        if len(token) < 100:  # 过滤掉短 token
            return

        # 提取 host
        host = re.sub(r"^https?://([^/]+)/.*$", r"\1", req.url)

        if host not in captured_tokens:
            captured_tokens[host] = token
            print(f"[捕获] {host}  (token 前40字符: {token[:40]}...)")

        # 检测 substrate token
        if host in TARGET_HOSTS and substrate_token is None:
            substrate_token = token
            print(f"[✅] 捕获到 substrate access_token!")

    # ── 启动浏览器 ────────────────────────────────────────────────────────────
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            USER_DATA_DIR,
            headless=args.headless,
            args=["--disable-blink-features=AutomationControlled"],
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()

        # 注册请求拦截
        page.on("request", on_request)

        # 导航
        page.goto(CHAT_URL, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(2000)

        # 登录
        if not args.sniff_only:
            if is_logged_in(page):
                print("[LOGIN] ✅ 已有登录态，跳过登录")
            else:
                do_login(page, email, password)

        # 等待页面加载并触发带 token 的请求
        print(f"\n[INFO] 页面: {page.url}")
        print(f"[INFO] 等待 Copilot 请求（最多 {args.timeout} 秒）...\n")

        # 等待 substrate token 出现
        deadline = time.time() + args.timeout
        while substrate_token is None and time.time() < deadline:
            page.wait_for_timeout(1000)

        # ── 结果 ──────────────────────────────────────────────────────────────
        print(f"\n{'='*60}")
        print(f"  抓到的 token（按 host）")
        print(f"{'='*60}")
        for host in sorted(captured_tokens.keys()):
            marker = " ⬅ substrate" if host in TARGET_HOSTS else ""
            print(f"  {host}{marker}")

        if substrate_token:
            save_token(substrate_token)
        else:
            print(f"\n[WARN] ❌ 未捕获到 substrate.office.com 的 token")
            print(f"[HINT] 已捕获 {len(captured_tokens)} 个 host 的 token，但都不是 substrate")
            print(f"[HINT] 尝试手动在浏览器中打开 Copilot 对话触发请求")

            # 如果有其他 token，保存第一个作为备选
            if captured_tokens:
                first_host = next(iter(captured_tokens))
                first_token = captured_tokens[first_host]
                claims = decode_jwt_payload(first_token) or {}
                aud = claims.get("aud", "")
                print(f"[HINT] 已捕获的 token aud: {aud}")
                # 如果 aud 包含 substrate 或 sydney，也保存
                if "substrate" in aud or "sydney" in aud:
                    save_token(first_token)

        ctx.close()


if __name__ == "__main__":
    main()
