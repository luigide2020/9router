#!/bin/bash
# M365 Token 全流程：本地抓取 → 本地 DB → 同步远程 → 远程 DB
#
# 前置条件：
#   - 远程与本地 clone 同一个 9router 项目
#   - ~/.ssh/config 中配置 Host oracle
#
# 用法：
#   ./scripts/m365/sync_remote.sh              # headless 模式
#   ./scripts/m365/sync_remote.sh --no-headless # 有浏览器界面
#
# 环境变量：
#   M365_EMAIL       M365 邮箱
#   M365_PASSWORD    M365 密码
#   REMOTE_PROJECT   远程项目路径（默认 $HOME/9router）

set -e

HOST="${HOST:-oracle}"
REMOTE_PROJECT="${REMOTE_PROJECT:-\$HOME/9router}"
TOKEN_DIR="$HOME/.9router"
TOKEN_FILE="$TOKEN_DIR/m365-token.json"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

HEADLESS="--headless"
[ "$1" = "--no-headless" ] && HEADLESS=""

# ========== 第一步：本地抓 token ==========
echo "========== [STEP 1] 本地抓取 token =========="
M365_EMAIL="$M365_EMAIL" M365_PASSWORD="$M365_PASSWORD" \
    uv run python "$SCRIPT_DIR/login.py" $HEADLESS --close

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
echo "========== [STEP 3] scp → $HOST:$TOKEN_DIR/ =========="
scp "$TOKEN_FILE" "$HOST:$TOKEN_DIR/m365-token.json"

# ========== 第四步：更新远程 DB ==========
echo ""
echo "========== [STEP 4] ssh $HOST → update_db =========="
ssh "$HOST" "python3 $REMOTE_PROJECT/scripts/m365/update_db.py"

echo ""
echo "✅ 全流程完成"
