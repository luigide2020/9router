#!/bin/bash
# Quick calculation of token remaining time
python3 -c "
from datetime import datetime, timezone
import json

with open('/Users/liujie/.9router/m365-token.json') as f:
    d = json.load(f)

expires = datetime.fromisoformat(d.get('expiresAt','').replace('Z','+00:00'))
now = datetime.now(timezone.utc)
remaining = int((expires - now).total_seconds() / 60)
print(remaining)
"
