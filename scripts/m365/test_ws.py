"""
M365 Copilot WebSocket 连接测试脚本

用法:
    uv run scripts/m365/test_ws.py                   # 使用 .env 中的 token
    uv run scripts/m365/test_ws.py --token "eyJ..."  # 直接传入 token
    uv run scripts/m365/test_ws.py --prompt "你好"    # 自定义 prompt

环境准备:
    cp scripts/m365/.env.example scripts/m365/.env
    # 编辑 .env 填入你的 access token
"""

import argparse
import asyncio
import base64
import json
import os
import sys
import uuid
from pathlib import Path

import websockets
from dotenv import load_dotenv

# ── 加载 .env ──────────────────────────────────────────────────────────────────
ENV_PATH = Path(__file__).parent / ".env"
load_dotenv(ENV_PATH)

WS_BASE = "wss://substrate.office.com/m365chat/SecuredChathub"


def decode_jwt_payload(token: str) -> dict:
    """从 JWT access token 中解码 payload（不验证签名）"""
    parts = token.split(".")
    if len(parts) != 3:
        raise ValueError("Invalid JWT format: expected 3 parts")
    payload = parts[1]
    # 补齐 base64 padding
    padding = 4 - len(payload) % 4
    if padding != 4:
        payload += "=" * padding
    decoded = base64.urlsafe_b64decode(payload)
    return json.loads(decoded)


def build_ws_url(token: str) -> tuple[str, dict]:
    """构造 M365 Copilot WebSocket URL，返回 (url, claims)"""
    claims = decode_jwt_payload(token)
    oid = claims.get("oid", "")
    tid = claims.get("tid", "")
    session_id = str(uuid.uuid4())
    client_request_id = str(uuid.uuid4())

    url = (
        f"{WS_BASE}/{oid}@{tid}"
        f"?X-ClientRequestId={client_request_id}"
        f"&X-SessionId={session_id}"
        f"&access_token={token}"
    )
    return url, claims


def build_init_frame() -> str:
    """构造 init 帧"""
    return json.dumps({"protocol": "json", "version": 1}) + "\x1e"


def build_ping_frame() -> str:
    """构造 ping 帧 (type 6)"""
    return json.dumps({"type": 6}) + "\x1e"


def build_message_frame(text: str, invocation_id: int = 0) -> str:
    """构造用户消息帧 (type 4)"""
    msg = {
        "type": 4,
        "invocationId": str(invocation_id),
        "target": "SendMessage",
        "arguments": [
            {
                "message": {
                    "type": "message",
                    "role": "user",
                    "content": text,
                }
            }
        ],
    }
    return json.dumps(msg) + "\x1e"


def parse_ws_frame(data: str) -> list[dict]:
    """解析 WebSocket 帧（以 \\x1e 分隔）"""
    parts = data.split("\x1e")
    messages = []
    for part in parts:
        part = part.strip()
        if not part:
            continue
        try:
            messages.append(json.loads(part))
        except json.JSONDecodeError:
            pass
    return messages


async def test_connection(token: str, prompt: str, verbose: bool = False):
    """测试 M365 Copilot WebSocket 连接"""
    url, claims = build_ws_url(token)

    print(f"[INFO] 用户: {claims.get('name', claims.get('upn', 'unknown'))}")
    print(f"[INFO] OID:  {claims.get('oid', 'N/A')}")
    print(f"[INFO] TID:  {claims.get('tid', 'N/A')}")
    print(f"[INFO] 过期: {claims.get('exp', 'N/A')}")
    if verbose:
        print(f"[DEBUG] URL: {url[:120]}...")

    headers = {
        "Origin": "https://m365.cloud.microsoft",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    }

    print(f"\n[INFO] 正在连接 WebSocket...")
    try:
        async with websockets.connect(
            url,
            additional_headers=headers,
            open_timeout=15,
            close_timeout=5,
        ) as ws:
            print("[OK]   WebSocket 已连接")

            # 1. 发送 init 帧
            await ws.send(build_init_frame())
            print("[INFO] 已发送 init 帧")

            # 等待 init 响应
            try:
                init_resp = await asyncio.wait_for(ws.recv(), timeout=10)
                init_msgs = parse_ws_frame(init_resp)
                if verbose:
                    print(f"[DEBUG] Init 响应: {init_msgs}")
                print("[OK]   收到 init 响应")
            except asyncio.TimeoutError:
                print("[WARN] Init 响应超时，继续尝试...")

            # 2. 发送 ping
            await ws.send(build_ping_frame())

            # 3. 发送用户消息
            print(f"\n[INFO] 发送消息: {prompt}")
            await ws.send(build_message_frame(prompt, invocation_id=0))

            # 4. 接收流式响应
            print("[INFO] 等待响应...\n")
            full_text = ""
            msg_count = 0

            async def recv_loop():
                nonlocal full_text, msg_count
                try:
                    async for raw in ws:
                        messages = parse_ws_frame(raw)
                        for msg in messages:
                            msg_type = msg.get("type")
                            if msg_type == 6:
                                # ping，忽略
                                continue
                            elif msg_type == 1:
                                # 流式增量
                                chunk = (
                                    msg.get("arguments", [{}])[0]
                                    .get("message", {})
                                    .get("content", "")
                                )
                                if chunk:
                                    print(chunk, end="", flush=True)
                                    full_text += chunk
                                    msg_count += 1
                            elif msg_type == 2:
                                # 完成帧
                                items = msg.get("item", {}).get("messages", [])
                                for item in items:
                                    c = item.get("content", "")
                                    if c and not full_text:
                                        print(c, end="", flush=True)
                                        full_text += c
                                print()  # 换行
                                return
                            elif msg_type == 3:
                                # 错误帧
                                err = msg.get("error", "unknown error")
                                print(f"\n[ERROR] {err}")
                                return
                            elif msg_type == 7:
                                # close
                                return
                            else:
                                if verbose:
                                    print(f"\n[DEBUG] type={msg_type}: {json.dumps(msg, ensure_ascii=False)[:200]}")
                except websockets.ConnectionClosed:
                    print("\n[WARN] 连接被关闭")

            await asyncio.wait_for(recv_loop(), timeout=120)

            print(f"\n\n{'='*60}")
            print(f"[OK]   收到 {msg_count} 个流式帧")
            print(f"[OK]   响应长度: {len(full_text)} 字符")
            if full_text:
                print(f"[OK]   响应前 200 字: {full_text[:200]}")

    except websockets.InvalidStatusCode as e:
        print(f"[ERROR] WebSocket 连接失败: HTTP {e.status_code}")
        if e.status_code == 401:
            print("[HINT] Token 可能已过期，请重新获取")
    except asyncio.TimeoutError:
        print("[ERROR] 连接超时")
    except Exception as e:
        print(f"[ERROR] {type(e).__name__}: {e}")


def main():
    parser = argparse.ArgumentParser(description="M365 Copilot WebSocket 测试")
    parser.add_argument("--token", help="M365 access token (JWT)")
    parser.add_argument("--prompt", default=None, help="测试 prompt")
    parser.add_argument("--verbose", "-v", action="store_true", help="显示详细调试信息")
    args = parser.parse_args()

    # 优先用命令行参数，否则从环境变量读取
    token = args.token or os.getenv("M365_ACCESS_TOKEN", "")
    prompt = args.prompt or os.getenv("TEST_PROMPT", "Hello, what can you do?")

    if not token:
        print("[ERROR] 未提供 access token")
        print(f"[HINT] 请设置环境变量 M365_ACCESS_TOKEN 或使用 --token 参数")
        print(f"[HINT] 或创建 {ENV_PATH} 文件（参考 .env.example）")
        sys.exit(1)

    # 基本 JWT 格式检查
    if token.count(".") != 2:
        print("[ERROR] Token 不是有效的 JWT 格式")
        sys.exit(1)

    # 检查过期
    try:
        import jwt as pyjwt
        claims = pyjwt.decode(token, options={"verify_signature": False})
        import time
        exp = claims.get("exp", 0)
        if exp and exp < time.time():
            print("[WARN] Token 已过期！连接可能会失败")
            print(f"[WARN] 过期时间: {pyjwt.api_jwt.datetime.utcfromtimestamp(exp)}")
    except Exception as e:
        print(f"[WARN] 无法解析 JWT: {e}")

    print("=" * 60)
    print("  M365 Copilot WebSocket 连接测试")
    print("=" * 60)

    asyncio.run(test_connection(token, prompt, verbose=args.verbose))


if __name__ == "__main__":
    main()
