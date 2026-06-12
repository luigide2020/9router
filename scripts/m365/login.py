"""
M365 Copilot 登录 + access_token 抓取脚本

原理：
  - 拦截 HTTP 请求头 Authorization: Bearer
  - 拦截 WebSocket 连接 URL 中的 access_token 参数
  - 拦截 WebSocket 帧中的 JWT token
  - 解码每个 token 的 aud/scp 帮助识别正确的 Copilot token

用法:
    export M365_EMAIL="your@email.com"
    export M365_PASSWORD="your_password"
    uv run scripts/m365/login.py                # 登录 + 抓 token
    uv run scripts/m365/login.py --sniff-only   # 复用缓存登录态
"""

import argparse
import base64
import hashlib
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

# Copilot 相关的 aud 关键词（按优先级）
COPILOT_AUD_KEYWORDS = ["substrate", "sydney", "copilot", "m365chat"]


def decode_jwt_payload(token: str) -> dict | None:
    """解码 JWT payload（不验证签名）"""
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return None
        seg = parts[1] + "=" * (-len(parts[1]) % 4)
        return json.loads(base64.urlsafe_b64decode(seg))
    except Exception:
        return None


def is_copilot_token(claims: dict) -> bool:
    """判断是否为 Copilot 用的 token"""
    aud = (claims.get("aud") or "").lower()
    scp = (claims.get("scp") or "").lower()
    return any(kw in aud or kw in scp for kw in COPILOT_AUD_KEYWORDS)


def is_logged_in(page):
    return page.locator('input[type="email"]').count() == 0


def do_login(page, email, password):
    print("[LOGIN] 输入邮箱...")
    page.fill('input[type="email"]', email)
    page.click('input[type="submit"]')

    print("[LOGIN] 等待密码框...")
    page.wait_for_selector('input[type="password"]', timeout=15000)
    page.fill('input[type="password"]', password)
    page.click('input[type="submit"]')

    try:
        page.wait_for_selector('#idSIButton9', timeout=8000)
        page.click('#idSIButton9')
    except PwTimeout:
        pass

    print("[LOGIN] 等待跳转...")
    page.wait_for_url("**m365.cloud.microsoft/**", timeout=30000)
    print("[LOGIN] ✅ 登录成功")


def save_token(token: str, claims: dict) -> None:
    """保存 access token 到文件"""
    TOKEN_DIR.mkdir(parents=True, exist_ok=True)

    exp = claims.get("exp")
    expires_at = datetime.fromtimestamp(exp, tz=timezone.utc).isoformat() if exp else "unknown"
    user = claims.get("upn") or claims.get("preferred_username") or "unknown"

    data = {
        "accessToken": token,
        "extractedAt": datetime.now(tz=timezone.utc).isoformat(),
        "expiresAt": expires_at,
        "aud": claims.get("aud", "unknown"),
        "scp": claims.get("scp", "unknown"),
        "userPrincipalName": user,
        "tenantId": claims.get("tid", "unknown"),
        "objectId": claims.get("oid", "unknown"),
        "clientId": claims.get("appid") or claims.get("azp") or "unknown",
    }

    TOKEN_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False))
    print(f"\n[TOKEN] ✅ 已保存到 {TOKEN_FILE}")
    print(f"  用户: {user}")
    print(f"  aud:  {data['aud']}")
    print(f"  过期: {expires_at}")
    if exp:
        remaining = exp - time.time()
        print(f"  剩余: {remaining / 60:.0f} 分钟")


def main():
    parser = argparse.ArgumentParser(description="M365 Copilot 登录 + access_token 抓取")
    parser.add_argument("--sniff-only", action="store_true", help="跳过登录，直接抓 token")
    parser.add_argument("--headless", action="store_true", help="无头模式")
    parser.add_argument("--timeout", type=int, default=60, help="等待 token 的超时秒数")
    parser.add_argument("--auto-save", action="store_true", default=True,
                        help="自动保存第一个 Copilot token（默认开启）")
    args = parser.parse_args()

    email = os.environ.get("M365_EMAIL", "")
    password = os.environ.get("M365_PASSWORD", "")

    if not args.sniff_only and (not email or not password):
        print("[ERROR] 请设置环境变量 M365_EMAIL 和 M365_PASSWORD")
        sys.exit(1)

    # ── 全量 token 收集 ──────────────────────────────────────────────────────
    seen: dict[str, dict] = {}  # hash -> {aud, scp, appid, url, via, token, claims}
    copilot_token: str | None = None
    copilot_claims: dict | None = None

    def record(token: str, url: str, via: str):
        nonlocal copilot_token, copilot_claims
        if not token or len(token) < 100:
            return
        h = hashlib.md5(token.encode()).hexdigest()[:8]
        if h in seen:
            return

        claims = decode_jwt_payload(token) or {}
        aud = claims.get("aud", "(opaque/non-jwt)")
        scp = claims.get("scp", "")
        appid = claims.get("appid") or claims.get("azp", "")

        info = {
            "aud": aud,
            "scp": scp,
            "appid": appid,
            "url": url,
            "via": via,
            "token": token,
            "claims": claims,
        }
        seen[h] = info

        marker = ""
        if is_copilot_token(claims):
            marker = " ⬅ COPILOT"
            if copilot_token is None:
                copilot_token = token
                copilot_claims = claims

        print(f"\n[{via}] {url[:80]}")
        print(f"   aud  = {aud}{marker}")
        if scp:
            print(f"   scp  = {scp}")
        if appid:
            print(f"   appid= {appid}")

    # 1) HTTP 请求头 Bearer
    def on_request(req):
        auth = req.headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            record(auth[7:], req.url, "http-header")
        # query 里的 access_token
        m = re.search(r"[?&]access_token=([^&]+)", req.url)
        if m:
            record(m.group(1), req.url, "http-query")

    # 2) WebSocket 连接
    def _scan_frame(payload, url):
        """扫描 WebSocket 帧中的 JWT token"""
        try:
            text = payload if isinstance(payload, str) else payload.decode("utf-8", "ignore")
        except Exception:
            return
        for tok in re.findall(r"eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+", text):
            record(tok, url + " (frame)", "ws-frame")

    def on_ws(ws):
        print(f"\n[WS] {ws.url[:100]}")
        m = re.search(r"[?&]access_token=([^&]+)", ws.url)
        if m:
            record(m.group(1), ws.url, "ws-query")
        # 有些实现把 token 放在第一帧
        ws.on("framesent", lambda frame: _scan_frame(frame.get("payload", ""), ws.url))

    # ── 启动浏览器 ────────────────────────────────────────────────────────────
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            USER_DATA_DIR,
            headless=args.headless,
            args=["--disable-blink-features=AutomationControlled"],
        )

        # 在 context 级别挂，覆盖所有页面/弹窗
        ctx.on("request", on_request)
        ctx.on("websocket", on_ws)

        page = ctx.pages[0] if ctx.pages else ctx.new_page()

        # 导航
        page.goto(CHAT_URL, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(2000)

        # 登录
        if not args.sniff_only:
            if is_logged_in(page):
                print("[LOGIN] ✅ 已有登录态，跳过登录")
            else:
                do_login(page, email, password)

        # 等待页面加载
        page.wait_for_url("**/chat**", timeout=30000)
        page.wait_for_timeout(5000)
        print(f"\n[INFO] 页面: {page.url}")

        # 发送一条消息触发 Copilot 请求
        print("[INFO] 尝试发送测试消息触发 Copilot 请求...")
        try:
            box = page.get_by_role("textbox").last
            box.click()
            box.fill("hello")
            box.press("Enter")
            print("[INFO] ✅ 已发送测试消息")
        except Exception as e:
            print(f"[WARN] 自动发送失败: {e}")
            print("[WARN] 请手动在浏览器中发送一条消息")

        # 等待 Copilot token 出现
        print(f"\n[INFO] 等待 Copilot token（最多 {args.timeout} 秒）...")
        deadline = time.time() + args.timeout
        while copilot_token is None and time.time() < deadline:
            page.wait_for_timeout(1000)

        # ── 结果汇总 ──────────────────────────────────────────────────────────
        print(f"\n{'=' * 60}")
        print(f"  全部 token（共 {len(seen)} 个）")
        print(f"{'=' * 60}")
        for h, info in seen.items():
            marker = " ⬅ COPILOT" if is_copilot_token(info.get("claims", {})) else ""
            print(f"  - aud={info['aud']}  scp={info['scp'][:50]}  via={info['via']}{marker}")

        if copilot_token and copilot_claims:
            save_token(copilot_token, copilot_claims)
        else:
            print(f"\n[WARN] ❌ 未找到 Copilot token")
            print(f"[HINT] 共捕获 {len(seen)} 个 token，但 aud 都不匹配 {COPILOT_AUD_KEYWORDS}")
            print(f"[HINT] 请查看上面的 aud 列表，手动确认哪个是 Copilot 用的")

            # 保存所有 token 供调试
            debug_file = TOKEN_DIR / "m365-all-tokens.json"
            debug_data = []
            for h, info in seen.items():
                debug_data.append({
                    "aud": info["aud"],
                    "scp": info["scp"],
                    "appid": info["appid"],
                    "via": info["via"],
                    "url": info["url"][:120],
                    "token_preview": info["token"][:60] + "...",
                })
            debug_file.write_text(json.dumps(debug_data, indent=2, ensure_ascii=False))
            print(f"[DEBUG] 所有 token 已保存到 {debug_file}")

        ctx.close()


if __name__ == "__main__":
    main()
