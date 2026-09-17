#!/bin/bash
# Quick token check script
TOKEN_FILE="/Users/liujie/.9router/m365-token.json"
if [ -f "$TOKEN_FILE" ]; then
    EXPIRES_AT=$(python3 -c "import json; d=json.load(open('$TOKEN_FILE')); print(d.get('expiresAt','N/A'))")
    echo "expiresAt: $EXPIRES_AT"
fi
