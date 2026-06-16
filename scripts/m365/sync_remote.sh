#!/bin/bash
set -e

# launchd 环境极简，显式补 PATH
export PATH="/Users/liujie/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# 自动定位 uv（找不到就用绝对路径兜底，记得按 which uv 的结果改）
UV="$(command -v uv 2>/dev/null || echo /Users/liujie/.local/bin/uv)"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"

# 进入项目目录，确保 uv run 能找到正确的 venv / pyproject.toml
cd "$PROJECT_DIR"

M365_EMAIL="${M365_EMAIL:-$(grep '^M365_EMAIL=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "\"'")}"
M365_PASSWORD="${M365_PASSWORD:-$(grep '^M365_PASSWORD=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "\"'")}"

HOST="${HOST:-oracle}"
REMOTE_TOKEN_DIR='~/.9router'
REMOTE_SCRIPT='~/9router/scripts/m365/update_db.py'
TOKEN_DIR="$HOME/.9router"
TOKEN_FILE="$TOKEN_DIR/m365-token.json"

HEADLESS="--headless"
[ "$1" = "--no-headless" ] && HEADLESS=""

echo "========== [STEP 1] 本地抓取 token =========="
env M365_EMAIL="$M365_EMAIL" M365_PASSWORD="$M365_PASSWORD" \
    "$UV" run python "$SCRIPT_DIR/login.py" $HEADLESS --close

[ -f "$TOKEN_FILE" ] || { echo "[ERROR] token 文件未生成: $TOKEN_FILE"; exit 1; }

echo "========== [STEP 2] 更新本地 DB =========="
"$UV" run python "$SCRIPT_DIR/update_db.py"     # ← 改用 uv run

echo "========== [STEP 3] scp → $HOST =========="
scp "$TOKEN_FILE" "$HOST:$REMOTE_TOKEN_DIR/m365-token.json"

echo "========== [STEP 4] ssh $HOST → update_db =========="
ssh "$HOST" "python3 $REMOTE_SCRIPT"   # 远程同理，最好也确认远程用对了 python/venv

echo "✅ 全流程完成"