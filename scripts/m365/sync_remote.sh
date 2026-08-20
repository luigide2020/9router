#!/bin/bash
set -e

unset VIRTUAL_ENV

export PATH="/Users/liujie/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

UV="$(command -v uv 2>/dev/null || echo /Users/liujie/.local/bin/uv)"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

cd "$PROJECT_DIR"

HOST="${HOST:-oracle}"
REMOTE_TOKEN_DIR='~/.9router'
REMOTE_SCRIPT='~/9router/scripts/m365/update_db.py'
TOKEN_DIR="$HOME/.9router"
TOKEN_FILE="$TOKEN_DIR/m365-token.json"

M365_PROXY_PORT="${M365_PROXY_PORT:-7891}"

HEADLESS="--headless"
FORCE_CLEAR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --no-headless) HEADLESS="" ;;
    --force-clear) FORCE_CLEAR="--force-clear" ;;
  esac
  shift
done

# 临时设置 macOS 系统代理，让 Chromium 走系统代理（比 --proxy-server 快）
# 仅 Wi-Fi 和 Ethernet 接口，执行完后恢复
NETWORK_SERVICES="Wi-Fi Ethernet"

setup_system_proxy() {
  echo "========== [STEP 0] 设置系统代理 → 127.0.0.1:$M365_PROXY_PORT =========="
  for svc in $NETWORK_SERVICES; do
    echo "  设置 $svc ..."
    networksetup -setwebproxy "$svc" 127.0.0.1 "$M365_PROXY_PORT" 2>/dev/null
    networksetup -setsecurewebproxy "$svc" 127.0.0.1 "$M365_PROXY_PORT" 2>/dev/null
    networksetup -setsocksfirewallproxy "$svc" 127.0.0.1 "$M365_PROXY_PORT" 2>/dev/null
  done
  PROXY_WAS_SET=true
}

restore_system_proxy() {
  if [ "$PROXY_WAS_SET" = true ]; then
    echo "========== [CLEANUP] 恢复系统代理 =========="
    for svc in Wi-Fi Ethernet; do
      networksetup -setwebproxystate "$svc" off 2>/dev/null
      networksetup -setsecurewebproxystate "$svc" off 2>/dev/null
      networksetup -setsocksfirewallproxystate "$svc" off 2>/dev/null
    done
  fi
}

trap restore_system_proxy EXIT

setup_system_proxy

echo "========== [STEP 1] 本地抓取 token =========="
"$UV" run python "$SCRIPT_DIR/login.py" $HEADLESS --close $FORCE_CLEAR --no-proxy || exit 1

[ -f "$TOKEN_FILE" ] || { echo "[ERROR] token 文件未生成: $TOKEN_FILE"; exit 1; }

echo "========== [STEP 2] 更新本地 DB =========="
"$UV" run python "$SCRIPT_DIR/update_db.py"

echo "========== [STEP 3] scp → $HOST =========="
scp "$TOKEN_FILE" "$HOST:$REMOTE_TOKEN_DIR/m365-token.json"

echo "========== [STEP 4] ssh $HOST → update_db =========="
ssh "$HOST" "python3 $REMOTE_SCRIPT"

echo "✅ 全流程完成"