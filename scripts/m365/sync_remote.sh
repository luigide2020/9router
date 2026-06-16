#!/bin/bash
# M365 Token 全流程：本地抓取 → 本地 DB → 同步远程 → 远程 DB
#
# 前置条件：
#   - 远程与本地 clone 同一个 9router 项目
#   - ~/.ssh/config 中配置 Host oracle
#   - .env 中填写 M365_EMAIL 和 M365_PASSWORD
#
# 用法：
#   ./scripts/m365/sync_remote.sh              # headless 模式（默认）
#   ./scripts/m365/sync_remote.sh --no-headless # 有浏览器界面

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$(cd "$SCRIPT_DIR/../.." && pwd)/.env"

# 从项目 .env 文件读取凭证（优先使用已 export 的环境变量）
M365_EMAIL="${M365_EMAIL:-$(grep '^M365_EMAIL=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "\"'")}"
M365_PASSWORD="${M365_PASSWORD:-$(grep '^M365_PASSWORD=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "\"'")}"

HOST="${HOST:-oracle}"
REMOTE_TOKEN_DIR='~/.9router'
REMOTE_SCRIPT='~/9router/scripts/m365/update_db.py'
TOKEN_DIR="$HOME/.9router"
TOKEN_FILE="$TOKEN_DIR/m365-token.json"

# headless 参数（默认 headless，传 --no-headless 则显示浏览器）
HEADLESS="--headless"
if [ "$1" = "--no-headless" ]; then
    HEADLESS=""
fi

# ========== 第一步：本地抓 token ==========
echo "========== [STEP 1] 本地抓取 token =========="
env M365_EMAIL="$M365_EMAIL" M365_PASSWORD="$M365_PASSWORD" \
    /usr/bin/env uv run python "$SCRIPT_DIR/login.py" $HEADLESS --close

if [ ! -f "$TOKEN_FILE" ]; then
    echo "[ERROR] token 文件未生成: $TOKEN_FILE"
    exit 1
fi

# ========== 第二步：更新本地 DB ==========
echo ""
echo "========== [STEP 2] 更新本地 DB =========="
python3 "$SCRIPT_DIR/update_db.py"

# ========== 第三步：同步 token 到远程 ==========
echo ""
echo "========== [STEP 3] scp → $HOST:$REMOTE_TOKEN_DIR/ =========="
scp "$TOKEN_FILE" "$HOST:$REMOTE_TOKEN_DIR/m365-token.json"

# ========== 第四步：更新远程 DB ==========
echo ""
echo "========== [STEP 4] ssh $HOST → update_db =========="
ssh "$HOST" "python3 $REMOTE_SCRIPT"

echo ""
echo "✅ 全流程完成"
