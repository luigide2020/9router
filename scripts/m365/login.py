"""
M365 Copilot access_token 抓取（修正 websocket 监听挂载点）
关键修正：websocket 是 Page 事件，不是 BrowserContext 事件。
必须 page.on("websocket", ...)，之前 ctx.on("websocket") 永不触发。

代理策略：
- 默认：自动设置 macOS 系统代理 (networksetup)，浏览器和区域检测都走系统代理
- 浏览器不使用 --proxy-server（HTTP CONNECT 会禁用 QUIC，导致慢）
- M365_PROXY 环境变量不再需要
"""
import argparse, base64, json, os, re, subprocess, sys, time, urllib.parse, urllib.request
from datetime import datetime, timezone
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")
except ImportError:
    pass

try:
    from playwright.sync_api import sync_playwright, TimeoutError as PwTimeout
except ImportError:
    print("❌ 运行: uv add playwright && uv run playwright install chromium")
    sys.exit(1)

CHAT_URL = "https://m365.cloud.microsoft/chat"

ALLOWED_COUNTRY_CODES = {"TW"}

SYSTEM_PROXY_PORT = int(os.environ.get("M365_PROXY_PORT", "7891"))
NETWORK_SERVICES = ["Wi-Fi", "Ethernet"]

_proxy_was_set = False
_proxy_original_state = {}


def _run_networksetup(*args):
    try:
        subprocess.run(["networksetup", *args], capture_output=True, timeout=5)
    except Exception:
        pass


def _get_proxy_state(service, proxy_type):
    try:
        result = subprocess.run(
            ["networksetup", f"-get{proxy_type}proxy", service],
            capture_output=True, text=True, timeout=5,
        )
        return result.stdout.strip()
    except Exception:
        return ""


def setup_system_proxy():
    global _proxy_was_set, _proxy_original_state
    _proxy_original_state = {}
    for svc in NETWORK_SERVICES:
        for ptype in ("web", "secureweb", "socksfirewall"):
            key = f"{svc}:{ptype}"
            _proxy_original_state[key] = _get_proxy_state(svc, ptype)
            state_key = f"{svc}:{ptype}:state"
            _proxy_original_state[state_key] = _get_proxy_state(svc, ptype).split("\n")[0] if _get_proxy_state(svc, ptype) else ""
    for svc in NETWORK_SERVICES:
        _run_networksetup("-setwebproxy", svc, "127.0.0.1", str(SYSTEM_PROXY_PORT))
        _run_networksetup("-setsecurewebproxy", svc, "127.0.0.1", str(SYSTEM_PROXY_PORT))
        _run_networksetup("-setsocksfirewallproxy", svc, "127.0.0.1", str(SYSTEM_PROXY_PORT))
    _proxy_was_set = True
    os.environ["HTTP_PROXY"] = f"http://127.0.0.1:{SYSTEM_PROXY_PORT}"
    os.environ["HTTPS_PROXY"] = f"http://127.0.0.1:{SYSTEM_PROXY_PORT}"
    print(f"[PROXY] ✅ 系统代理已设置 → 127.0.0.1:{SYSTEM_PROXY_PORT} ({', '.join(NETWORK_SERVICES)})")


def restore_system_proxy():
    global _proxy_was_set
    if not _proxy_was_set:
        return
    for svc in NETWORK_SERVICES:
        _run_networksetup("-setwebproxystate", svc, "off")
        _run_networksetup("-setsecurewebproxystate", svc, "off")
        _run_networksetup("-setsocksfirewallproxystate", svc, "off")
    _proxy_was_set = False
    os.environ.pop("HTTP_PROXY", None)
    os.environ.pop("HTTPS_PROXY", None)
    print("[PROXY] ✅ 系统代理已恢复")


def detect_region_by_ip():
    """通过出口 IP 归属地检测网络区域（走系统代理 / HTTP_PROXY 环境变量）"""
    apis = [
        ("http://ip-api.com/json/?fields=status,countryCode,country,query", "ip-api"),
        ("https://ipapi.co/json/", "ipapi.co"),
    ]
    proxy_url = os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY")
    if proxy_url:
        print(f"[REGION] 使用代理检测出口 IP: {proxy_url}")
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({"http": proxy_url, "https": proxy_url}))
    else:
        opener = urllib.request.build_opener()
    for url, name in apis:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "curl/8.0"})
            with opener.open(req, timeout=8) as resp:
                data = json.loads(resp.read().decode())
            print(f"[REGION] {name} 返回: {json.dumps(data, ensure_ascii=False)[:200]}")
            if name == "ip-api" and data.get("status") == "success":
                return data.get("countryCode", ""), data.get("country", ""), data.get("query", "")
            if name == "ipapi.co" and "country_code" in data:
                return data.get("country_code", ""), data.get("country_name", ""), data.get("ip", "")
        except Exception as e:
            print(f"[REGION] {name} 查询失败: {e}")
            continue
    return None, None, None


def check_region_or_exit():
    """区域预检：通过出口 IP 判断，仅允许 TW（依赖系统代理）"""
    code, country, ip = detect_region_by_ip()
    if code and code.upper() in ALLOWED_COUNTRY_CODES:
        print(f"[REGION] ✅ 出口 IP: {ip}，区域: {country}({code})，允许执行")
        return
    if code:
        print(f"[REGION] ❌ 出口 IP: {ip}，区域: {country}({code})，不在允许列表 ({'/'.join(sorted(ALLOWED_COUNTRY_CODES))})，退出")
    else:
        print("[REGION] ❌ 无法检测出口 IP 归属地，退出")
    sys.exit(0)

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
    # 如果页面上有邮箱输入框，说明未登录
    # 但 M365 登录页可能用不同的 selector，所以也检查 URL
    if page.locator('input[type="email"]').count() > 0:
        return False
    if page.locator('input[name="loginfmt"]').count() > 0:
        return False
    if 'login' in page.url.lower() or 'login.microsoftonline' in page.url.lower():
        return False
    return True


def is_on_chat_page(page):
    # 如果已经在 chat 页面，说明登录成功了
    return 'chat' in page.url


def do_login(page, email, password):
    print("[LOGIN] 等待登录页面加载...")
    # Wait for login page - try multiple possible selectors
    try:
        page.wait_for_selector('input[type="email"]', timeout=10000)
    except PwTimeout:
        try:
            page.wait_for_selector('input[name="loginfmt"]', timeout=10000)
        except PwTimeout:
            try:
                page.wait_for_selector('input[name="login"]', timeout=10000)
            except PwTimeout:
                # Last resort: wait for any visible input on the page
                page.wait_for_selector('input', timeout=10000)
    
    print(f"[LOGIN] 当前 URL: {page.url}")
    print("[LOGIN] 输入邮箱...")
    # Try each selector individually; skip checkboxes/toggles to avoid matching switches
    email_selectors = [
        'input[type="email"]',
        'input[name="loginfmt"]',
        'input[name="login"]',
        'input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"])',
    ]
    email_box = None
    for sel in email_selectors:
        elems = page.locator(sel).all()
        for el in elems:
            tag = el.evaluate("e => e.tagName.toLowerCase()")
            typ = el.evaluate("e => e.type || e.getAttribute('type') || ''")
            role = el.evaluate("e => e.getAttribute('role') || ''")
            if typ in ("checkbox", "radio", "hidden", "submit", "button") or role in ("switch", "checkbox"):
                continue
            try:
                el.fill(email)
                email_box = el
                print(f"[LOGIN] ✅ 已填入邮箱 (selector={sel})")
                break
            except Exception:
                continue
        if email_box is not None:
            break
    if email_box is None:
        raise RuntimeError("无法找到邮箱输入框")

    # Click submit — prefer the button associated with the email field
    submit_selectors = [
        'input[type="submit"]',
        'button[type="submit"]',
        'text=Next',
        'text=登录',
        'text=Sign in',
    ]
    clicked = False
    for sel in submit_selectors:
        try:
            page.locator(sel).first.click(timeout=5000)
            clicked = True
            print(f"[LOGIN] ✅ 已点击提交 (selector={sel})")
            break
        except Exception:
            continue
    if not clicked:
        page.keyboard.press("Enter")
    print("[LOGIN] 等待密码框...")
    page.wait_for_selector('input[type="password"]', timeout=15000)
    page.fill('input[type="password"]', password)
    page.click('input[type="submit"]')
    try:
        page.wait_for_selector('#idSIButton9', timeout=8000)
        page.click('#idSIButton9')
    except PwTimeout:
        pass
    # Wait for chat page to load (login success)
    for _ in range(6):
        if 'm365.cloud.microsoft' in page.url:
            break
        try:
            page.wait_for_url("**m365.cloud.microsoft/**", timeout=10000)
            break
        except PwTimeout:
            page.wait_for_timeout(2000)
    else:
        print(f"[LOGIN] ⚠️ wait_for_url 超时，当前URL: {page.url}")
    print("[LOGIN] ✅ 登录成功")


def main():
    import atexit
    atexit.register(restore_system_proxy)

    ap = argparse.ArgumentParser()
    ap.add_argument("--sniff-only", action="store_true")
    ap.add_argument("--headless", action="store_true")
    ap.add_argument("--attempts", type=int, default=6)
    ap.add_argument("--wait", type=int, default=12)
    ap.add_argument("--close", action="store_true")
    ap.add_argument("--skip-region-check", action="store_true", help="跳过区域检测")
    ap.add_argument("--force-clear", action="store_true", help="强制清空浏览器缓存，清除旧登录态")
    args = ap.parse_args()

    setup_system_proxy()

    if not args.skip_region_check:
        check_region_or_exit()

    email = os.environ.get("M365_EMAIL", "")
    password = os.environ.get("M365_PASSWORD", "")
    if not args.sniff_only and (not email or not password):
        print("[ERROR] 请设置 M365_EMAIL 和 M365_PASSWORD")
        sys.exit(1)

    # Force clear browser cache to remove old login state
    if args.force_clear:
        import shutil
        browser_profile = Path(USER_DATA_DIR)
        if browser_profile.exists():
            print(f"[CLEAR] 删除旧浏览器缓存: {browser_profile}")
            shutil.rmtree(browser_profile)
            browser_profile.mkdir(parents=True, exist_ok=True)
            print("[CLEAR] ✅ 缓存已清空")
        else:
            print("[CLEAR] 缓存目录不存在，跳过")

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

    def click_history_and_type(page):
        history_selectors = [
            'nav a[href^="/chat/"]:not([href="/chat/all"]):not([href="/chat/"])',
            'a[href^="/chat/"]:not([href="/chat/all"]):not([href="/chat/"])',
            '[role="listbox"] [role="option"]',
            'nav button[aria-label*="聊天"]',
            'nav button[aria-label*="Chat"]',
        ]
        for sel in history_selectors:
            try:
                items = page.locator(sel).all()
                if len(items) == 0:
                    continue
                idx = min(1, len(items) - 1)
                items[idx].click(timeout=5000, force=True)
                print(f"[INFO] ✅ 点击了第 {idx+1} 个历史聊天 (selector={sel}, total={len(items)})")
                page.wait_for_timeout(3000)
                try:
                    page.wait_for_selector('[role="textbox"], div[contenteditable="true"]', state="visible", timeout=10000)
                except Exception:
                    pass
                page.wait_for_timeout(2000)
                break
            except Exception as e:
                print(f"[INFO] selector={sel} 失败: {e}")
                continue
        else:
            print("[INFO] 没找到历史聊天，尝试直接输入")

        import random, string
        word = ''.join(random.choices(string.ascii_lowercase, k=5))
        for sel in ['div[contenteditable="true"]', 'textarea', '[role="textbox"]']:
            try:
                box = page.locator(sel).last
                box.click(timeout=3000)
                try:
                    box.press("Control+A")
                    box.press("Delete")
                except Exception:
                    pass
                box.type(word, delay=120)
                page.keyboard.press("Enter")
                print(f"[INFO] ✅ 已在 {sel} 输入并发送: {word}")
                return True
            except Exception:
                continue
        print("[WARN] 没定位到输入框")
        return False

    launch_kwargs = dict(
        user_data_dir=USER_DATA_DIR, headless=args.headless,
        args=[
            "--disable-blink-features=AutomationControlled",
            "--disable-features=AutomationControlled",
        ],
        user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
    )
    print("[PROXY] 浏览器走系统代理 (不使用 --proxy-server，保留 QUIC)")

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(**launch_kwargs)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()

        page.on("websocket", on_ws)
        ctx.on("page", lambda pg: pg.on("websocket", on_ws))

        try:
            page.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
        except Exception:
            pass

        page.goto(CHAT_URL, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(2000)

        # Check if page actually loaded (network failure detection)
        current_url = page.url
        if current_url.startswith("about:blank") or "error" in current_url.lower() or "unreachable" in current_url.lower():
            print(f"[ERROR] 页面未正常加载，当前URL: {current_url}")
            print("[INFO] 可能是网络不可达，关闭浏览器退出")
            ctx.close()
            sys.exit(1)

        # Verify page content is M365 (not a browser error page)
        try:
            page_title = page.title()
            if not page_title or "error" in page_title.lower() or "unreachable" in page_title.lower():
                print(f"[ERROR] 页面标题异常: {page_title}")
                ctx.close()
                sys.exit(1)
        except Exception:
            pass

        if not args.sniff_only:
            try:
                page.wait_for_url("**/chat**", timeout=15000)
            except PwTimeout:
                pass
            if is_logged_in(page):
                print("[LOGIN] ✅ 已有登录态")
            else:
                do_login(page, email, password)
                page.wait_for_url("**/chat**", timeout=30000)
                page.wait_for_timeout(3000)

        for i in range(1, args.attempts + 1):
            if target["token"]:
                break
            print(f"\n========== 第 {i}/{args.attempts} 轮：reload → 等聊天框 → 点历史 → 敲字 → 等 WS ==========")
            try:
                page.reload(wait_until="commit", timeout=90000)
            except Exception as e:
                print(f"[WARN] reload 失败: {e}")
                if "net::" in str(e).lower() or "err_" in str(e).lower():
                    print(f"[ERROR] 网络不可达，终止重试")
                    break
                continue
            try:
                page.wait_for_selector(
                    'div[contenteditable="true"], textarea, [role="textbox"]',
                    timeout=30000,
                )
                print("[INFO] ✅ 聊天框已出现")
            except PwTimeout:
                # Check if page is a network error
                try:
                    body_text = page.locator("body").inner_text(timeout=3000)
                    if any(kw in body_text.lower() for kw in ["err_internet", "net::", "can't reach", "refused", "timed out"]):
                        print(f"[ERROR] 网络错误页面，终止重试: {body_text[:100]}")
                        break
                except Exception:
                    pass
                print(f"[WARN] 聊天框30s未出现，当前URL: {page.url}")
                continue
            click_history_and_type(page)
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