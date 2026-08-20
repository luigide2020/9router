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

HEADLESS="--headless"
FORCE_CLEAR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --no-headless) HEADLESS="" ;;
    --force-clear) FORCE_CLEAR="--force-clear" ;;
  esac
  shift
done

echo "========== [STEP 1] 本地抓取 token =========="
"$UV" run python "$SCRIPT_DIR/login.py" $HEADLESS --close $FORCE_CLEAR || exit 1

[ -f "$TOKEN_FILE" ] || { echo "[ERROR] token 文件未生成: $TOKEN_FILE"; exit 1; }

echo "========== [STEP 2] 更新本地 DB =========="
"$UV" run python "$SCRIPT_DIR/update_db.py"

echo "========== [STEP 3] scp → $HOST =========="
scp "$TOKEN_FILE" "$HOST:$REMOTE_TOKEN_DIR/m365-token.json"

echo "========== [STEP 4] ssh $HOST → update_db =========="
ssh "$HOST" "python3 $REMOTE_SCRIPT"

echo "✅ 全流程完成"
