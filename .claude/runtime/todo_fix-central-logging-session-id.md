# TODO: Fix Central Logging System - CLAUDE_SESSION_ID Issue

**Priority:** Medium
**Created:** 2026-02-16
**Session:** 20260216-181217-3fc1

---

## Problem

The central logging helper scripts (`log-decision.sh`, `log-improvement.sh`) fail silently when `CLAUDE_SESSION_ID` environment variable is not set:

```bash
$ ~/.claude/bin/log-decision.sh "Decision" "Alternatives" "Rationale"
[WARN] CLAUDE_SESSION_ID is not set, skipping decision log

$ ~/.claude/bin/log-improvement.sh "Description" priority
[WARN] CLAUDE_SESSION_ID is not set, skipping improvement log
```

However, `update-work-status.sh` works correctly and creates/uses session directories.

---

## Current Behavior

**Working:**
- ✅ `update-work-status.sh` - Creates session directories and updates status
- ✅ Session directories are created at `.claude/runtime/logs/<session_id>/`
- ✅ Template files exist (decisions.md, improvements.md, session.log, metadata.json)

**Not Working:**
- ❌ `log-decision.sh` - Requires CLAUDE_SESSION_ID env var
- ❌ `log-improvement.sh` - Requires CLAUDE_SESSION_ID env var
- ❌ No automatic setting of CLAUDE_SESSION_ID in Claude Code sessions

---

## Root Cause Analysis

1. **Session ID Detection Logic Inconsistency:**
   - `update-work-status.sh` has logic to detect/create session ID
   - `log-decision.sh` and `log-improvement.sh` only check env var
   - No session ID is exported to environment during Claude Code sessions

2. **Missing Session Initialization:**
   - No hook or mechanism sets `CLAUDE_SESSION_ID` at session start
   - `.claude/runtime/current_session_id` file not being used/created
   - Environment variable not propagated to Claude Code tool calls

---

## Evidence from Session 20260216-181217-3fc1

```bash
# Environment check showed:
$ echo "CLAUDE_SESSION_ID env var: ${CLAUDE_SESSION_ID:-not set}"
CLAUDE_SESSION_ID env var: not set

$ cat .claude/runtime/current_session_id 2>/dev/null || echo "No current_session_id file"
No current_session_id file

# Yet work status update succeeded:
$ ~/.claude/bin/update-work-status.sh done "Summary"
[SUCCESS] Updated session 20260216-181217-3fc1 status to: done
```

---

## Impact

**Current Workaround:**
- Manual logging required (write directly to session log files)
- Inconsistent logging behavior across helper scripts
- Risk of forgetting to log important decisions/improvements

**Developer Experience:**
- Confusing warnings during logging attempts
- Extra manual work to save session insights
- Loss of structured decision/improvement tracking

---

## Proposed Solutions

### Option 1: Make Logging Scripts Self-Sufficient (Recommended)

**Change:** Update `log-decision.sh` and `log-improvement.sh` to detect session ID like `update-work-status.sh` does.

**Pros:**
- Consistent behavior across all helper scripts
- No environment variable dependency
- Works immediately without session initialization changes

**Implementation:**
```bash
# In log-decision.sh and log-improvement.sh, add:
if [ -z "$CLAUDE_SESSION_ID" ]; then
  # Auto-detect session ID (same logic as update-work-status.sh)
  CLAUDE_SESSION_ID=$(detect_or_create_session_id)
fi
```

### Option 2: Export CLAUDE_SESSION_ID at Session Start

**Change:** Create a PostSessionStart hook or modify Claude Code to export `CLAUDE_SESSION_ID`.

**Pros:**
- Central session management
- Environment variable available to all tools
- Cleaner architecture

**Cons:**
- Requires changes to Claude Code hooks or core behavior
- More complex implementation

### Option 3: Use .claude/runtime/current_session_id File

**Change:** All scripts read session ID from `.claude/runtime/current_session_id` if env var not set.

**Pros:**
- File-based session tracking
- No environment variable needed
- Persists across tool calls

**Cons:**
- Need to ensure file is created/updated reliably
- Concurrent session handling complexity

---

## Recommended Approach

**Implement Option 1 immediately** (self-sufficient scripts) for quick fix, then **consider Option 2** for long-term architecture improvement.

### Step 1: Extract Session Detection Logic
Create `~/.claude/bin/lib/detect-session-id.sh`:
```bash
#!/usr/bin/env bash
# Shared session ID detection logic

detect_or_create_session_id() {
  # Check env var first
  if [ -n "$CLAUDE_SESSION_ID" ]; then
    echo "$CLAUDE_SESSION_ID"
    return 0
  fi

  # Check current_session_id file
  if [ -f ".claude/runtime/current_session_id" ]; then
    cat .claude/runtime/current_session_id
    return 0
  fi

  # Create new session ID
  local session_id=$(date +"%Y%m%d-%H%M%S")-$(openssl rand -hex 2)
  mkdir -p .claude/runtime/logs/$session_id
  echo "$session_id" > .claude/runtime/current_session_id

  # Create template files
  create_session_templates "$session_id"

  echo "$session_id"
}
```

### Step 2: Update Logging Scripts
Modify `log-decision.sh` and `log-improvement.sh`:
```bash
#!/usr/bin/env bash
source ~/.claude/bin/lib/detect-session-id.sh

SESSION_ID=$(detect_or_create_session_id)
LOG_DIR=".claude/runtime/logs/$SESSION_ID"

# ... rest of script uses $LOG_DIR ...
```

### Step 3: Optional - Add PostSessionStart Hook
For Option 2, create `.claude/hooks/post-session-start.sh`:
```bash
#!/usr/bin/env bash
# Auto-create session and export ID

SESSION_ID=$(date +"%Y%m%d-%H%M%S")-$(openssl rand -hex 2)
echo "$SESSION_ID" > .claude/runtime/current_session_id
export CLAUDE_SESSION_ID="$SESSION_ID"

echo "[session] Started session $SESSION_ID"
```

---

## Testing Plan

1. **Test automatic session detection:**
   ```bash
   unset CLAUDE_SESSION_ID
   ~/.claude/bin/log-decision.sh "Test" "Alt" "Rationale"
   # Should NOT show warning, should create/use session
   ```

2. **Test env var override:**
   ```bash
   export CLAUDE_SESSION_ID="20260216-181217-3fc1"
   ~/.claude/bin/log-improvement.sh "Test improvement" high
   # Should use existing session
   ```

3. **Test concurrent logging:**
   ```bash
   # Multiple log calls in same session
   log-decision.sh "Decision 1" "..." "..."
   log-decision.sh "Decision 2" "..." "..."
   log-improvement.sh "Improvement 1" high
   # All should go to same session directory
   ```

---

## Success Criteria

✅ `log-decision.sh` and `log-improvement.sh` work without `CLAUDE_SESSION_ID` env var
✅ Session ID automatically detected or created
✅ Consistent behavior across all logging helper scripts
✅ No manual logging required for decisions/improvements
✅ Session logs properly structured and complete

---

## References

**Related Files:**
- `~/.claude/bin/log-decision.sh`
- `~/.claude/bin/log-improvement.sh`
- `~/.claude/bin/update-work-status.sh` (working example)
- `.claude/runtime/logs/<session_id>/decisions.md`
- `.claude/runtime/logs/<session_id>/improvements.md`

**Session Evidence:**
- Session 20260216-181217-3fc1 (this session)
- Manual logging workaround applied successfully

**CLAUDE.md References:**
- Lines 199-245: Automatic Session Logging (Central Summary System)
- Lines 247-296: When to Log Decisions/Improvements

---

## Next Steps

1. Review `update-work-status.sh` to understand working session detection logic
2. Extract session detection into shared library function
3. Update `log-decision.sh` and `log-improvement.sh` to use shared function
4. Test with and without `CLAUDE_SESSION_ID` env var
5. Update CLAUDE.md documentation if behavior changes
6. Consider implementing PostSessionStart hook for cleaner architecture

---

**Status:** Ready for implementation
**Estimated Effort:** 1-2 hours
**Blocking:** No (workaround available)
**Impact:** Medium (improves DX, enables structured logging)
