#!/usr/bin/env bash
# Resume session helper - shows recent session logs

set -euo pipefail

LOGS_DIR=".claude/runtime/logs"

# List recent sessions
echo "📚 Recent Sessions:"
echo ""

if [ ! -d "${LOGS_DIR}" ]; then
    echo "No sessions found. Logs will be created automatically on next Claude Code run."
    exit 0
fi

# Find and display recent sessions
find "${LOGS_DIR}" -name "context.md" -type f -exec stat -f "%m %N" {} \; 2>/dev/null | \
    sort -rn | \
    head -5 | \
    while read -r timestamp filepath; do
        session_id=$(basename "$(dirname "${filepath}")")
        modified=$(date -r "${timestamp}" '+%Y-%m-%d %H:%M')
        echo "• ${session_id} (${modified})"
        echo "  Read: cat ${filepath}"
        echo ""
    done

# If a session ID is provided, show its log
if [ $# -eq 1 ]; then
    SESSION_ID="$1"
    SESSION_LOG="${LOGS_DIR}/${SESSION_ID}/session.log"

    if [ -f "${SESSION_LOG}" ]; then
        echo "📖 Session Log: ${SESSION_ID}"
        echo ""
        cat "${SESSION_LOG}"
    else
        echo "❌ Session not found: ${SESSION_ID}"
    fi
fi
