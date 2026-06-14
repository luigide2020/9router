"""
M365 Copilot access_token 抓取（修正 websocket 监听挂载点）
关键修正：websocket 是 Page 事件，不是 BrowserContext 事件。
必须 page.on("websocket", ...)，之前 ctx.on("websocket") 永不触发。
"""
import argparse, base64, json, os, re, sys, time, urllib.parse
from datetime import datetime, timezone
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright, TimeoutError as PwTimeout
except ImportError:
    print("❌ 运行: uv add playwright && uv run playwright install chromium")
    sys.exit(1)

CHAT_URL = "https://m365.cloud.microsoft/chat"
USER_DATA_DIR = str(Path(__file__).parent / ".browser_profile")
TOKEN_DIR = Path.home() / ".9router"
TOKEN_FILE = TOKEN_DIR / "m365-token.json"
CHATHUB_PATH = "m365copilot/chathub/"


def atomic_write(path, text):
    tmp = str(path) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)



def decode_jwt_payload(token):
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return None
        seg = parts[1] + "=" * (-len(parts[1]) % 4)
        return json.loads(base64.urlsafe_b64decode(seg))
    except Exception:
        return None


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
    page.wait_for_url("**m365.cloud.microsoft/**", timeout=30000)
    print("[LOGIN] ✅ 登录成功")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sniff-only", action="store_true")
    ap.add_argument("--headless", action="store_true")
    ap.add_argument("--attempts", type=int, default=6)
    ap.add_argument("--wait", type=int, default=12)
    ap.add_argument("--close", action="store_true")
    args = ap.parse_args()

    email = os.environ.get("M365_EMAIL", "")
    password = os.environ.get("M365_PASSWORD", "")
    if not args.sniff_only and (not email or not password):
        print("[ERROR] 请设置 M365_EMAIL 和 M365_PASSWORD")
        sys.exit(1)

    target = {"token": None}

    def save_target(token, source_url):
        TOKEN_DIR.mkdir(parents=True, exist_ok=True)
        c = decode_jwt_payload(token) or {}
        exp = c.get("exp")
        data = {
            "accessToken": token,
            "source": "ws-chathub",
            "wsUrl": source_url.split("access_token=")[0] + "access_token=<redacted>",
            "extractedAt": datetime.now(tz=timezone.utc).isoformat(),
            "expiresAt": datetime.fromtimestamp(exp, tz=timezone.utc).isoformat() if exp else "unknown",
            "aud": c.get("aud", "unknown"),
            "scp": c.get("scp", "unknown"),
            "userPrincipalName": c.get("upn") or c.get("preferred_username") or "unknown",
            "tenantId": c.get("tid", "unknown"),
        }
        atomic_write(TOKEN_FILE, json.dumps(data, indent=2, ensure_ascii=False))
        print(f"\n[TOKEN] ✅ 已保存到 {TOKEN_FILE}")
        print(f"  aud={data['aud']} scp={data['scp']}")
        if exp:
            print(f"  剩余: {(exp - time.time())/60:.0f} 分钟")

    def capture_from_url(url):
        if CHATHUB_PATH not in url.lower():
            return False
        m = re.search(r"[?&]access_token=([^&]+)", url)
        if not m:
            print(f"[WS] 命中 Chathub 但 URL 无 token(协商阶段):\n  {url[:120]}")
            return False
        token = urllib.parse.unquote(m.group(1))
        if len(token) < 100:
            return False
        if target["token"] is None:
            target["token"] = token
            print(f"\n[✅ 命中 Chathub WS] {url[:90]}...")
            save_target(token, url)
        return True

    def on_ws(ws):
        print(f"[WS] {ws.url[:120]}")  # ← 现在这行终于会打印了
        capture_from_url(ws.url)

        def scan(payload):
            if target["token"] is not None:
                return
            if CHATHUB_PATH not in ws.url.lower():
                return
            try:
                text = payload if isinstance(payload, str) else payload.decode("utf-8", "ignore")
            except Exception:
                return
            m = re.search(r"eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+", text)
            if m and len(m.group(0)) > 100:
                target["token"] = m.group(0)
                print("\n[✅ 命中 Chathub WS 首帧]")
                save_target(m.group(0), ws.url)

        ws.on("framesent", scan)
        ws.on("framereceived", scan)

    def type_one_char(page):
        for sel in ['div[contenteditable="true"]', 'textarea', '[role="textbox"]']:
            try:
                box = page.locator(sel).last
                box.click(timeout=3000)
                try:
                    box.press("Control+A")
                    box.press("Delete")
                except Exception:
                    pass
                box.type("h", delay=120)
                print(f"[INFO] ✅ 已在 {sel} 输入一个字符")
                return True
            except Exception:
                continue
        print("[WARN] 没定位到输入框")
        return False

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            USER_DATA_DIR, headless=args.headless,
            args=["--disable-blink-features=AutomationControlled"])
        page = ctx.pages[0] if ctx.pages else ctx.new_page()

        # ★★★ 核心修正：websocket 监听挂在 page 上，不是 ctx ★★★
        page.on("websocket", on_ws)
        ctx.on("page", lambda pg: pg.on("websocket", on_ws))  # 新标签页也覆盖

        page.goto(CHAT_URL, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(2000)

        if not args.sniff_only:
            if is_logged_in(page):
                print("[LOGIN] ✅ 已有登录态")
            else:
                do_login(page, email, password)
                page.wait_for_url("**/chat**", timeout=30000)
                page.wait_for_timeout(3000)

        for i in range(1, args.attempts + 1):
            if target["token"]:
                break
            print(f"\n========== 第 {i}/{args.attempts} 轮：reload → 敲字 → 等 WS ==========")
            try:
                page.reload(wait_until="domcontentloaded")
            except Exception as e:
                print(f"[WARN] reload 失败: {e}")
            page.wait_for_timeout(4000)
            type_one_char(page)
            deadline = time.time() + args.wait
            while target["token"] is None and time.time() < deadline:
                page.wait_for_timeout(1000)
            if target["token"]:
                print(f"[INFO] 第 {i} 轮成功抓到 token")
                break
            print(f"[INFO] 第 {i} 轮没抓到，准备重试...")

        if target["token"]:
            print("\n✅ 成功锁定 Copilot Chathub 的 access_token")
        else:
            print("\n[WARN] 没抓到。浏览器保持打开，手动 F5 + 敲字，监听常驻会自动落盘。")

        if args.close and target["token"]:
            ctx.close()
        else:
            print("\n浏览器保持打开。退出按 Ctrl+C。")
            try:
                while True:
                    page.wait_for_timeout(1000)
            except KeyboardInterrupt:
                ctx.close()


if __name__ == "__main__":
    main()