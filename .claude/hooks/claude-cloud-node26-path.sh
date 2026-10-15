#!/bin/bash
# Put Node 26 ahead of the cloud image's /opt/node22/bin on PATH for every
# Bash command in a Claude Code cloud session. Local sessions are untouched.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

if [ -x /opt/node26/bin/node ] && [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo 'export PATH="/opt/node26/bin:$PATH"' >> "$CLAUDE_ENV_FILE"
fi
