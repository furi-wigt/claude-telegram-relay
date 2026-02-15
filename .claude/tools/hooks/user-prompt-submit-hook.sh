#!/usr/bin/env bash
# Session logging hook - runs after every user message
# Automatically creates and maintains session logs

set -euo pipefail

# Get session ID from environment or generate one
SESSION_ID="${CLAUDE_SESSION_ID:-$(date +%Y%m%d_%H%M%S)}"
SESSION_DIR=".claude/runtime/logs/${SESSION_ID}"
SESSION_LOG="${SESSION_DIR}/session.log"
CONTEXT_FILE="${SESSION_DIR}/context.md"

# Get user prompt from environment or use placeholder
USER_PROMPT="${CLAUDE_USER_PROMPT:-[No prompt available]}"

# Create session directory if it doesn't exist
mkdir -p "${SESSION_DIR}"

# Initialize session log if it's a new session
if [ ! -f "${SESSION_LOG}" ]; then
    cat > "${SESSION_LOG}" << EOF
# Session Log - ${SESSION_ID}
Started: $(date '+%Y-%m-%d %H:%M:%S')
Project: $(basename "$(pwd)")

## Session Timeline
EOF
fi

# Log the user prompt
{
    echo ""
    echo "---"
    echo "**[$(date '+%H:%M:%S')]** User:"
    echo "${USER_PROMPT}" | sed 's/^/  /'
} >> "${SESSION_LOG}"

# Update context file with key information
cat > "${CONTEXT_FILE}" << EOF
# Session Context - ${SESSION_ID}

**Project:** $(basename "$(pwd)")
**Started:** $(head -2 "${SESSION_LOG}" | tail -1 | cut -d: -f2-)
**Last Activity:** $(date '+%Y-%m-%d %H:%M:%S')

## Quick Resume

To get up to speed on this session, read:
- Full log: \`${SESSION_LOG}\`
- This summary: Key decisions and context below

## Key Decisions
(Updated automatically as session progresses)

EOF

# Output the session ID for Claude to use
echo "📝 Session: ${SESSION_ID}"
echo "Log: ${SESSION_LOG}"
