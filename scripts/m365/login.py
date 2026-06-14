"""
M365 Copilot access_token 抓取（修正 websocket 监听挂载点）
关键修正：websocket 是 Page 事件，不是 BrowserContext 事件。
必须 page.on("websocket", ...)，之前 ctx.on("websocket") 永不触发。
"""
import argparse, base64, json, os, re, sqlite3, sys, time, urllib.parse, urllib.request, uuid
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
PROVIDER = "m365-copilot"
AUTH_TYPE = "cookie"
DEFAULT_REMOTE = "http://jiaguwen.plain.ccwu.cc:20128"


def get_db_path():
    data_dir = os.environ.get("DATA_DIR", str(TOKEN_DIR))
    return Path(data_dir) / "db" / "data.sqlite"


def atomic_write(path, text):
    tmp = str(path) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def iso_from_ts(ts):
    """Unix 秒 → UTC ISO 字符串，空值返回 None。"""
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat() if ts else None


def update_db(token, claims):
    """将 token 写入 SQLite providerConnections 表，供 executor 使用。"""
    db_path = get_db_path()
    if not db_path.exists():
        print(f"[DB] ⚠️ 数据库不存在: {db_path}")
        print(f"[DB] 请先启动 9router 初始化数据库，或设置 DATA_DIR 指向正确路径")
        return False

    now = datetime.now(tz=timezone.utc).isoformat()
    upn = claims.get("upn") or claims.get("preferred_username") or "unknown"
    data_obj = {"apiKey": token, "testStatus": "active"}
    if expires_at := iso_from_ts(claims.get("exp")):
        data_obj["expiresAt"] = expires_at

    try:
        with sqlite3.connect(str(db_path), timeout=10) as conn:
            conn.execute("PRAGMA busy_timeout = 5000")
            row = conn.execute(
                "SELECT id, data FROM providerConnections WHERE provider = ? LIMIT 1",
                (PROVIDER,),
            ).fetchone()
            if row:
                row_id, raw_data = row
                try:
                    existing = json.loads(raw_data) if raw_data else {}
                except json.JSONDecodeError:
                    existing = {}
                existing.update(data_obj)
                conn.execute(
                    "UPDATE providerConnections SET data = ?, updatedAt = ?, isActive = 1 WHERE id = ?",
                    (json.dumps(existing), now, row_id),
                )
                print(f"[DB] ✅ 已更新现有 m365-copilot 连接 (id={row_id[:8]}...)")
            else:
                new_id = str(uuid.uuid4())
                conn.execute(
                    """INSERT INTO providerConnections
                       (id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
                       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)""",
                    (new_id, PROVIDER, AUTH_TYPE, f"M365 ({upn})", upn, 1, json.dumps(data_obj), now, now),
                )
                print(f"[DB] ✅ 已创建新 m365-copilot 连接 (id={new_id[:8]}...)")
        return True
    except sqlite3.Error as e:
        print(f"[DB] ❌ SQLite 错误: {e}")
        return False


def push_to_remote(token, remote_url, remote_password=None):
    import json
    import urllib.request
    import urllib.error
    import http.cookiejar

    base = remote_url.rstrip("/")

    cookie_jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(cookie_jar),
    )

    auth_cookie = None

    # ===== 登录 =====
    if remote_password:
        login_url = base + "/api/auth/login"
        login_payload = json.dumps({
            "password": remote_password
        }).encode("utf-8")

        req = urllib.request.Request(
            login_url,
            data=login_payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        try:
            resp = opener.open(req, timeout=15)
            body = json.loads(resp.read().decode("utf-8"))

            if not body.get("success"):
                print(f"[REMOTE] ❌ 远程登录失败: {body.get('error')}")
                return False

            # ✅ 强制提取 cookie
            for c in cookie_jar:
                if c.name == "auth_token":
                    auth_cookie = f"{c.name}={c.value}"
                    break

            if not auth_cookie:
                print("[REMOTE] ❌ 登录成功但未获取 auth_token cookie")
                return False

            print("[REMOTE] ✅ 远程登录成功")

        except Exception as e:
            print(f"[REMOTE] ❌ 远程登录异常: {e}")
            return False

    # ===== 推送 =====
    url = base + "/api/oauth/m365-copilot"
    payload = json.dumps({
        "action": "save",
        "accessToken": token,
    }).encode("utf-8")

    headers = {
        "Content-Type": "application/json",
    }

    # ✅ 关键修复：手动塞 Cookie
    if auth_cookie:
        headers["Cookie"] = auth_cookie

    req = urllib.request.Request(
        url,
        data=payload,
        headers=headers,
        method="POST",
    )

    try:
        resp = opener.open(req, timeout=15)
        body = json.loads(resp.read().decode("utf-8"))

        if body.get("success"):
            print(f"[REMOTE] ✅ 已推送到 {remote_url}")
            return True

        print(f"[REMOTE] ❌ 推送失败: {body.get('error')}")
        return False

    except urllib.error.HTTPError as e:
        try:
            err = json.loads(e.read().decode("utf-8"))
            print(f"[REMOTE] ❌ 推送失败: {err.get('error')}")
        except Exception:
            print(f"[REMOTE] ❌ 推送失败: {e}")
        return False


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
    ap.add_argument("--update-db", action="store_true",
                    help="抓到 token 后直接写入本地 SQLite 数据库")
    ap.add_argument("--push-remote", action="store_true",
                    help="抓到 token 后通过 API 推送到远程 9router 服务")
    ap.add_argument("--remote-url", default=DEFAULT_REMOTE,
                    help=f"远程 9router 地址（默认: {DEFAULT_REMOTE}）")
    ap.add_argument("--remote-password", default=None,
                    help="远程 9router 的 dashboard 密码（也可通过 REMOTE_PASSWORD 环境变量设置）")
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
            "expiresAt": iso_from_ts(exp) or "unknown",
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
        if args.update_db:
            update_db(token, c)
        if args.push_remote:
            rp = args.remote_password or os.environ.get("REMOTE_PASSWORD", "")
            push_to_remote(token, args.remote_url, rp)

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