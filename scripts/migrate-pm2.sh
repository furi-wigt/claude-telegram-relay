#!/usr/bin/env bash
# migrate-pm2.sh — Replace old PM2 scheduled processes with new routines
#
# This script:
#   1. Stops and deletes old PM2 processes (smart-checkin, morning-briefing,
#      night-summary, watchdog) which pointed to examples/ or setup/
#   2. Keeps telegram-relay (ID 0) running untouched
#   3. Starts new processes from the updated ecosystem.config.cjs
#      (routines/ directory with new scripts)
#   4. Saves PM2 config and displays final status
#
# Usage: ./scripts/migrate-pm2.sh

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ECOSYSTEM_FILE="$PROJECT_DIR/ecosystem.config.cjs"

# Old process names to remove (these point to examples/ and setup/)
OLD_PROCESSES=("smart-checkin" "morning-briefing" "night-summary" "watchdog")

echo "=== PM2 Migration: Old Routines -> New Routines ==="
echo ""
echo "Project directory: $PROJECT_DIR"
echo ""

# Verify ecosystem.config.cjs exists
if [ ! -f "$ECOSYSTEM_FILE" ]; then
    echo "ERROR: $ECOSYSTEM_FILE not found."
    echo "Run the ecosystem config setup first."
    exit 1
fi

# Show current state
echo "--- Current PM2 processes ---"
pm2 list
echo ""

# Show what will be removed
echo "Processes to REMOVE (old scheduled tasks):"
for name in "${OLD_PROCESSES[@]}"; do
    if pm2 describe "$name" > /dev/null 2>&1; then
        echo "  - $name (running)"
    else
        echo "  - $name (not found, skipping)"
    fi
done
echo ""
echo "Process to KEEP:"
echo "  - telegram-relay (ID 0, will not be touched)"
echo ""

# Confirmation prompt
read -r -p "Proceed with migration? [y/N] " response
if [[ ! "$response" =~ ^[Yy]$ ]]; then
    echo "Migration cancelled."
    exit 0
fi

echo ""
echo "--- Stopping and deleting old processes ---"

for name in "${OLD_PROCESSES[@]}"; do
    if pm2 describe "$name" > /dev/null 2>&1; then
        echo "Stopping $name..."
        pm2 stop "$name" 2>/dev/null || true
        echo "Deleting $name..."
        pm2 delete "$name" 2>/dev/null || true
        echo "  Removed: $name"
    else
        echo "  Skipped: $name (not found)"
    fi
done

echo ""
echo "--- Starting new processes from ecosystem.config.cjs ---"

# Start only the new routine apps from ecosystem config.
# PM2 will skip telegram-relay if it is already running with the same name.
pm2 start "$ECOSYSTEM_FILE" --only morning-briefing,smart-checkin,night-summary,weekly-etf 2>/dev/null || \
    pm2 start "$ECOSYSTEM_FILE"

echo ""
echo "--- Saving PM2 configuration ---"
pm2 save

echo ""
echo "--- Migration complete ---"
pm2 list
echo ""
echo "Done. telegram-relay was not touched. New routines are active."
