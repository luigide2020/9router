"""
M365 Copilot 登录 + WebSocket 抓包脚本

用法:
    # 首次运行：设置环境变量后运行
    export M365_EMAIL="your@email.com"
    export M365_PASSWORD="your_password"
    uv run scripts/m365/login.py

    # 后续运行：会复用缓存的登录态
    uv run scripts/m365/login.py

    # 只抓包不登录（已有登录态时）
    uv run scripts/m365/login.py --sniff-only

    # 指定模式对比
    uv run scripts/m365/login.py --compare-modes

功能:
    1. 自动登录 M365（或复用缓存登录态）
    2. 拦截 WebSocket send，打印 optionsSets / options
    3. 提取 access token 和 refresh token 到 ~/.9router/m365-token.json
"""

import argparse
import json
import os
import sys
import base64
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright, TimeoutError as PwTimeout
except ImportError:
    print("❌ playwright 未安装。运行: uv add playwright && uv run playwright install chromium")
    sys.exit(1)

# ── 配置 ──────────────────────────────────────────────────────────────────────
URL = "https://m365.cloud.microsoft/chat"
USER_DATA_DIR = str(Path(__file__).parent / ".browser_profile")
TOKEN_DIR = Path.home() / ".9router"
TOKEN_FILE = TOKEN_DIR / "m365-token.json"

# ── WebSocket 拦截器（注入到页面） ────────────────────────────────────────────
WS_INTERCEPTOR_JS = """
() => {
    window.__wsCaptures = [];
    const OrigWS = window.WebSocket;

    window.WebSocket = function(url, protocols) {
        const ws = protocols ? new OrigWS(url, protocols) : new OrigWS(url);

        if (typeof url === 'string' && (url.includes('substrate') || url.includes('Chathub'))) {
            console.log('[HOOK] Copilot WebSocket detected');

            // 拦截 send
            const origSend = ws.send.bind(ws);
            ws.send = function(data) {
                if (typeof data === 'string') {
                    try {
                        const cleaned = data.replace(/\\u001e$/, '');
                        const msg = JSON.parse(cleaned);
                        if (msg.arguments && msg.arguments[0]) {
                            const capture = {
                                timestamp: Date.now(),
                                optionsSets: msg.arguments[0].optionsSets || [],
                                options: msg.arguments[0].options || {},
                                text: msg.arguments[0].message?.text || '',
                                target: msg.target || '',
                                type: msg.type,
                            };
                            window.__wsCaptures.push(capture);
                            console.log('[CAPTURED]', JSON.stringify(capture, null, 2));
                        }
                    } catch (e) {}
                }
                return origSend(data);
            };

            // 监听消息（用于调试）
            ws.addEventListener('message', (event) => {
                if (typeof event.data === 'string' && event.data.includes('"type":2')) {
                    console.log('[RESPONSE] Received type=2 (completion)');
                }
            });
        }

        return ws;
    };

    // 保持原型链
    window.WebSocket.prototype = OrigWS.prototype;
    window.WebSocket.CONNECTING = OrigWS.CONNECTING;
    window.WebSocket.OPEN = OrigWS.OPEN;
    window.WebSocket.CLOSING = OrigWS.CLOSING;
    window.WebSocket.CLOSED = OrigWS.CLOSED;

    console.log('[HOOK] WebSocket interceptor installed ✅');
}
"""

# ── Token 提取器 ──────────────────────────────────────────────────────────────
TOKEN_EXTRACT_JS = """
() => {
    const result = { accessToken: null, refreshToken: null, clientId: null, claims: null };

    try {
        const keys = Object.keys(localStorage);

        // 1. 找 access token
        for (const key of keys) {
            const value = localStorage.getItem(key);
            if (!value) continue;
            try {
                const parsed = JSON.parse(value);
                if (parsed.secret && (parsed.credentialType === 'AccessToken' || key.includes('accesstoken'))) {
                    const target = parsed.target || key || '';
                    if (target.includes('substrate') || target.includes('sydney') ||
                        key.includes('substrate') || key.includes('sydney')) {
                        const parts = parsed.secret.split('.');
                        if (parts.length >= 2) {
                            const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
                            if (payload.exp && payload.exp * 1000 > Date.now()) {
                                result.accessToken = parsed.secret;
                                result.claims = payload;
                                result.clientId = payload.appid || payload.azp || null;
                            }
                        }
                    }
                }
            } catch {}
        }

        // 2. 找 refresh token
        if (result.claims) {
            const uid = result.claims.oid || result.claims.sub || '';
            const utid = result.claims.tid || '';
            const homeAccountId = `${uid}.${utid}`;

            for (const key of keys) {
                if (!key.includes('refreshtoken')) continue;
                const value = localStorage.getItem(key);
                if (!value) continue;
                try {
                    const parsed = JSON.parse(value);
                    if (parsed.homeAccountId === homeAccountId) {
                        // 尝试 secret 字段（旧版 MSAL），再尝试 data 字段（新版加密）
                        result.refreshToken = parsed.secret || parsed.data || null;
                        break;
                    }
                } catch {}
            }
        }
    } catch (e) {
        result.error = e.message;
    }

    return result;
}
"""


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


def extract_tokens(page):
    """从 localStorage 提取 token"""
    # 确保在 outlook.office.com 域（token 存储在这里）
    current_url = page.url
    if "outlook.office.com" not in current_url:
        print("[TOKEN] 导航到 outlook.office.com 提取 token...")
        try:
            page.goto("https://outlook.office.com", wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(3000)
        except Exception:
            pass

    result = page.evaluate(TOKEN_EXTRACT_JS)
    return result


def save_tokens(token_data):
    """保存 token 到文件"""
    TOKEN_DIR.mkdir(parents=True, exist_ok=True)

    claims = token_data.get("claims") or {}
    token_file_data = {
        "accessToken": token_data.get("accessToken"),
        "refreshToken": token_data.get("refreshToken"),
        "clientId": token_data.get("clientId"),
        "extractedAt": __import__("datetime").datetime.now().isoformat(),
        "expiresAt": __import__("datetime").datetime.fromtimestamp(claims["exp"]).isoformat() if claims.get("exp") else "unknown",
        "userPrincipalName": claims.get("upn") or claims.get("preferred_username") or "unknown",
        "tenantId": claims.get("tid") or "unknown",
        "objectId": claims.get("oid") or "unknown",
    }

    TOKEN_FILE.write_text(json.dumps(token_file_data, indent=2, ensure_ascii=False))
    print(f"[TOKEN] ✅ 已保存到 {TOKEN_FILE}")
    print(f"  用户: {token_file_data['userPrincipalName']}")
    print(f"  过期: {token_file_data['expiresAt']}")
    print(f"  Refresh token: {'有' if token_file_data['refreshToken'] else '无（加密格式不可用）'}")
    return token_file_data


def wait_for_captures(page, prompt_text="Hello", timeout_sec=30):
    """发送消息并等待 WebSocket 捕获"""
    print(f"\n[SNIFF] 请在浏览器中发送消息，或等待自动发送...")
    print(f"[SNIFF] 等待 {timeout_sec} 秒内的 WebSocket 消息...")

    # 尝试在输入框中输入并发送
    try:
        textarea = page.locator('textarea, [contenteditable="true"], [role="textbox"]').first
        if textarea.is_visible(timeout=3000):
            textarea.fill(prompt_text)
            page.wait_for_timeout(500)
            # 按 Enter 发送
            page.keyboard.press("Enter")
            print(f"[SNIFF] 已自动发送: {prompt_text}")
    except Exception as e:
        print(f"[SNIFF] 自动发送失败: {e}")
        print(f"[SNIFF] 请手动在浏览器中发送一条消息")

    # 等待捕获
    page.wait_for_timeout(timeout_sec * 1000)

    # 读取捕获结果
    captures = page.evaluate("() => window.__wsCaptures || []")
    return captures


def print_captures(captures):
    """打印捕获的 WebSocket 消息"""
    if not captures:
        print("\n[RESULT] ❌ 未捕获到任何 WebSocket 消息")
        print("[HINT] 可能需要手动在浏览器中发送消息")
        return

    print(f"\n{'='*60}")
    print(f"[RESULT] 捕获到 {len(captures)} 条 WebSocket 消息")
    print(f"{'='*60}")

    for i, cap in enumerate(captures):
        print(f"\n--- 消息 #{i+1} ---")
        print(f"  时间: {cap.get('timestamp', 'N/A')}")
        print(f"  文本: {cap.get('text', '')[:80]}")
        print(f"  type: {cap.get('type', 'N/A')}")
        print(f"  target: {cap.get('target', 'N/A')}")
        print(f"  optionsSets: {json.dumps(cap.get('optionsSets', []), ensure_ascii=False)}")
        print(f"  options: {json.dumps(cap.get('options', {}), ensure_ascii=False)}")


def compare_modes(page):
    """对比不同模式的 optionsSets"""
    print("\n" + "="*60)
    print("  模式对比：Quick vs Think Deeper")
    print("="*60)

    captures = []

    # 模式 1: Auto/Quick
    print("\n[MODE 1] Auto/Quick 模式")
    print("[INFO] 请在浏览器中用 Quick 模式发送一条消息...")
    page.wait_for_timeout(20000)
    caps1 = page.evaluate("() => window.__wsCaptures || []")
    if caps1:
        captures.extend(caps1)
        print(f"  捕获到 {len(caps1)} 条")

    # 清空
    page.evaluate("() => { window.__wsCaptures = []; }")

    # 模式 2: Think Deeper
    print("\n[MODE 2] Think Deeper 模式")
    print("[INFO] 请切换到 Think Deeper 模式，再发送一条消息...")
    page.wait_for_timeout(30000)
    caps2 = page.evaluate("() => window.__wsCaptures || []")
    if caps2:
        captures.extend(caps2)
        print(f"  捕获到 {len(caps2)} 条")

    print_captures(captures)

    # 对比差异
    if len(captures) >= 2:
        print(f"\n{'='*60}")
        print("  差异分析")
        print(f"{'='*60}")
        s1 = set(json.dumps(captures[0].get("optionsSets", [])))
        s2 = set(json.dumps(captures[-1].get("optionsSets", [])))
        if s1 == s2:
            print("  optionsSets 相同（可能模式切换未生效）")
        else:
            print(f"  Quick:  {captures[0].get('optionsSets', [])}")
            print(f"  Think:  {captures[-1].get('optionsSets', [])}")


def main():
    parser = argparse.ArgumentParser(description="M365 Copilot 登录 + WebSocket 抓包")
    parser.add_argument("--sniff-only", action="store_true", help="跳过登录，直接抓包（需已有登录态）")
    parser.add_argument("--compare-modes", action="store_true", help="对比 Quick 和 Think Deeper 模式")
    parser.add_argument("--prompt", default="What is 2+2?", help="自动发送的测试消息")
    parser.add_argument("--headless", action="store_true", help="无头模式（不显示浏览器窗口）")
    args = parser.parse_args()

    email = os.environ.get("M365_EMAIL", "")
    password = os.environ.get("M365_PASSWORD", "")

    if not args.sniff_only and (not email or not password):
        print("[ERROR] 请设置环境变量 M365_EMAIL 和 M365_PASSWORD")
        print("  export M365_EMAIL='your@email.com'")
        print("  export M365_PASSWORD='your_password'")
        sys.exit(1)

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            USER_DATA_DIR,
            headless=args.headless,
            args=["--disable-blink-features=AutomationControlled"],
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()

        # 注入 WebSocket 拦截器（在导航前）
        page.add_init_script(WS_INTERCEPTOR_JS)

        # 导航到 M365
        page.goto(URL, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(3000)

        # 登录
        if not args.sniff_only:
            if is_logged_in(page):
                print("[LOGIN] ✅ 已有登录态，跳过登录")
            else:
                do_login(page, email, password)

        # 等待页面完全加载
        page.wait_for_timeout(5000)
        print(f"[INFO] 当前页面: {page.url}")
        print(f"[INFO] 标题: {page.title()}")

        # 提取 token
        print("\n[TOKEN] 提取 token...")
        token_data = extract_tokens(page)
        if token_data.get("accessToken"):
            saved = save_tokens(token_data)
        else:
            print("[TOKEN] ⚠️  未能提取 access token")
            if token_data.get("error"):
                print(f"[TOKEN] 错误: {token_data['error']}")

        # 抓包模式
        if args.compare_modes:
            compare_modes(page)
        else:
            captures = wait_for_captures(page, prompt_text=args.prompt)
            print_captures(captures)

        # 保持浏览器打开，按 q 退出
        print(f"\n{'='*60}")
        print("[INFO] 浏览器保持打开中")
        print("[INFO] 你可以在浏览器中继续操作")
        print("[INFO] 按 Ctrl+C 退出")
        try:
            while True:
                page.wait_for_timeout(2000)
                # 持续检查新的捕获
                new_caps = page.evaluate("() => (window.__wsCaptures || []).length")
                if new_caps > len(captures) if 'captures' in dir() else 0:
                    all_caps = page.evaluate("() => window.__wsCaptures || []")
                    print(f"[CAPTURED] 新增 {len(all_caps) - len(captures)} 条捕获")
                    captures = all_caps
        except KeyboardInterrupt:
            pass

        # 最终输出所有捕获
        final_caps = page.evaluate("() => window.__wsCaptures || []")
        if final_caps:
            print_captures(final_caps)

        ctx.close()


if __name__ == "__main__":
    main()
