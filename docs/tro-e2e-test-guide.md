# TRO Monthly Update — End-to-End Test Guide

Step-by-step isolation tests against **real external entities** (GitLab API, Telegram).
Run each step independently. Each has a clear **PASS / FAIL** signal.

---

## Prerequisites

Set the two GitLab variables if they are not already in `.env`:

```bash
# In the project root
grep GITLAB .env   # check what is already there
```

Add if missing:
```bash
echo 'GITLAB_BASE_URL=https://gitlab.com' >> .env
echo 'GITLAB_PERSONAL_ACCESS_TOKEN=glpat-xxxxxxxxxxxxxxxxxxxx' >> .env
```

Then export everything for the current shell:

```bash
cd /Users/furi/Documents/WorkInGovTech/01_Projects/Tools/claude-telegram-relay
set -a; source .env; set +a
```

---

## Step 1 — Pre-flight: required env vars

Verify every variable the pipeline needs is set before touching any external system.

```bash
for VAR in \
  GITLAB_BASE_URL \
  GITLAB_PERSONAL_ACCESS_TOKEN \
  TELEGRAM_BOT_TOKEN \
  TELEGRAM_USER_ID; do
  if [[ -z "${!VAR}" ]]; then
    echo "FAIL  $VAR is not set"
  else
    echo "PASS  $VAR = ${!VAR:0:12}..."
  fi
done
```

**PASS:** All lines print `PASS`.
**FAIL:** Any `FAIL` line → set the missing variable before continuing.

---

## Step 2 — GitLab: token authentication

One call to `/api/v4/user` — the fastest way to confirm the token is valid and has `read_api` scope.

```bash
curl -sS \
  -H "Authorization: Bearer $GITLAB_PERSONAL_ACCESS_TOKEN" \
  "$GITLAB_BASE_URL/api/v4/user" \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
if 'username' in d:
    print(f'PASS  authenticated as {d[\"username\"]} (id={d[\"id\"]})')
else:
    print('FAIL', d)
"
```

**PASS:** `PASS  authenticated as <your-username>`
**FAIL:** `401 Unauthorized` → token wrong or expired. `403 Forbidden` → token lacks `read_api`.

---

## Step 3 — GitLab: group 96143 access

Confirm the token can read the TRO group that the pipeline fetches from.

```bash
curl -sS \
  -H "Authorization: Bearer $GITLAB_PERSONAL_ACCESS_TOKEN" \
  "$GITLAB_BASE_URL/api/v4/groups/96143" \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
if 'id' in d:
    print(f'PASS  group id={d[\"id\"]} name=\"{d[\"full_name\"]}\"')
elif 'message' in d:
    print('FAIL', d['message'])
else:
    print('FAIL', d)
"
```

**PASS:** `PASS  group id=96143 name="..."`
**FAIL:** `404 Not Found` → group ID wrong or no access. Check with GitLab admin.

---

## Step 4 — GitLab: merge requests with pagination

Fetch MRs created in the last 35 days. This is what Phase 1 of the pipeline pulls.

```bash
SINCE=$(date -v-35d '+%Y-%m-%dT00:00:00Z' 2>/dev/null \
       || date --date='35 days ago' '+%Y-%m-%dT00:00:00Z')   # macOS / Linux

PAGE1="$GITLAB_BASE_URL/api/v4/groups/96143/merge_requests?scope=all&state=all&created_after=${SINCE}&per_page=100"

curl -sS -i \
  -H "Authorization: Bearer $GITLAB_PERSONAL_ACCESS_TOKEN" \
  "$PAGE1" \
  | python3 -c "
import sys, json
lines = sys.stdin.read()
header_block, _, body = lines.partition('\r\n\r\n')
link = next((l for l in header_block.splitlines() if l.lower().startswith('link:')), '')
mrs = json.loads(body)
print(f'PASS  {len(mrs)} MRs fetched (page 1)')
if 'rel=\"next\"' in link:
    print(f'      Pagination: more pages exist — Link header present')
else:
    print(f'      Pagination: single page (no Link rel=next)')
"
```

**PASS:** `PASS  N MRs fetched (page 1)` (N can be 0 if no MRs in window).
**FAIL:** JSON error or `401/403` → token or group issue.

---

## Step 5 — GitLab: issues with pagination

Same check for issues (also fetched in Phase 1).

```bash
SINCE=$(date -v-35d '+%Y-%m-%dT00:00:00Z' 2>/dev/null \
       || date --date='35 days ago' '+%Y-%m-%dT00:00:00Z')

PAGE1="$GITLAB_BASE_URL/api/v4/groups/96143/issues?scope=all&state=all&created_after=${SINCE}&per_page=100"

curl -sS \
  -H "Authorization: Bearer $GITLAB_PERSONAL_ACCESS_TOKEN" \
  "$PAGE1" \
  | python3 -c "
import sys, json
items = json.load(sys.stdin)
if isinstance(items, list):
    print(f'PASS  {len(items)} issues fetched')
else:
    print('FAIL', items)
"
```

**PASS:** `PASS  N issues fetched`.

---

## Step 6 — GitLab: projects in group (for milestones)

The pipeline iterates projects to extract milestones.

```bash
curl -sS \
  -H "Authorization: Bearer $GITLAB_PERSONAL_ACCESS_TOKEN" \
  "$GITLAB_BASE_URL/api/v4/groups/96143/projects?include_subgroups=true&per_page=100" \
  | python3 -c "
import sys, json
items = json.load(sys.stdin)
if isinstance(items, list):
    print(f'PASS  {len(items)} projects found in group')
    for p in items[:5]:
        print(f'      - {p[\"path_with_namespace\"]}')
    if len(items) > 5: print(f'      ... and {len(items)-5} more')
else:
    print('FAIL', items)
"
```

**PASS:** `PASS  N projects found` with a list of paths.

---

## Step 7 — Telegram: send a test message to yourself

Verify the bot token is live and can reach your personal chat.

```bash
curl -sS \
  -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -H "Content-Type: application/json" \
  -d "{\"chat_id\": $TELEGRAM_USER_ID, \"text\": \"[TRO E2E test] Step 7 — Telegram connectivity OK $(date)\"}" \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
if d.get('ok'):
    print(f'PASS  message sent, message_id={d[\"result\"][\"message_id\"]}')
else:
    print('FAIL', d.get('description', d))
"
```

**PASS:** Message appears on your Telegram + `PASS  message sent`.
**FAIL:** `401` → bot token wrong. `400 Bad Request` → user ID wrong.

---

## Step 8 — TRO Q&A state flag (no external calls)

Isolates `troQAState.ts` cross-process logic. No Telegram needed.

```bash
cd /Users/furi/Documents/WorkInGovTech/01_Projects/Tools/claude-telegram-relay

bun -e "
import { setTROQAActive, isTROQAActive, getTROQAState, clearTROQAActive, appendQAAnswer } from './src/tro/troQAState.ts';

const chatId = 999999;

// Write flag
setTROQAActive(chatId, 'test question 1\ntest question 2');
console.assert(isTROQAActive(chatId), 'FAIL  isTROQAActive after set');
console.log('PASS  setTROQAActive + isTROQAActive');

// Read state
const s = getTROQAState();
console.assert(s !== null, 'FAIL  getTROQAState returned null');
console.assert(s!.chatId === chatId, 'FAIL  chatId mismatch');
console.log('PASS  getTROQAState chatId matches');

// Append answer
appendQAAnswer(s!, 'My answer to question 1');
const s2 = getTROQAState();
console.assert(s2!.answers.length === 1, 'FAIL  answer not appended');
console.log('PASS  appendQAAnswer recorded');

// Clear
clearTROQAActive();
console.assert(!isTROQAActive(chatId), 'FAIL  still active after clear');
console.log('PASS  clearTROQAActive');
"
```

**PASS:** Four `PASS` lines, no `FAIL`.
**FAIL:** Any assertion error → check `src/tro/troQAState.ts` and the `logs/` directory is writable.

---

## Step 9 — PPTX generator standalone

Tests the Python script independently with a minimal fixture, so Phase 4 failures are isolated from Phase 1–3.

```bash
# Create a minimal outline fixture
cat > /tmp/tro-test-outline.json << 'EOF'
{
  "month": "Jan",
  "year": 2026,
  "slides": [
    {
      "layout": "title",
      "title": "TRO Monthly Update",
      "subtitle": "January 2026 — E2E Test"
    },
    {
      "layout": "content",
      "title": "Test Slide",
      "bullets": ["Item 1", "Item 2", "Item 3"]
    }
  ]
}
EOF

uv run \
  /Users/furi/Documents/WorkInGovTech/01_Projects/Agency_LTA/TRO/"Monthly Updates"/scripts/tro-pptx-generator.py \
  --outline /tmp/tro-test-outline.json \
  --output /tmp/tro-test-output.pptx \
  && echo "PASS  tro-pptx-generator.py produced /tmp/tro-test-output.pptx" \
  || echo "FAIL  script exited non-zero"

# Verify the file is a real PPTX (ZIP with PresentationML header)
python3 -c "
import zipfile, sys
try:
    z = zipfile.ZipFile('/tmp/tro-test-output.pptx')
    names = z.namelist()
    if any('ppt/slides' in n for n in names):
        print(f'PASS  valid PPTX ({len(names)} zip entries)')
    else:
        print('FAIL  ZIP exists but no ppt/slides/ found', names[:5])
except Exception as e:
    print('FAIL ', e)
"
```

**PASS:** Two `PASS` lines — script ran and file is valid PPTX.
**FAIL:** Script error → check `uv` is installed (`which uv`) and `requirements.txt` dependencies are present.

---

## Step 10 — Full pipeline ad-hoc run (force mode)

Bypasses the "already ran today" guard and runs all 5 phases against real systems.

> **Warning:** This sends real Telegram messages and will activate the Q&A window.
> Keep Telegram open. You have **15 minutes** to answer the context questions before it times out.

```bash
cd /Users/furi/Documents/WorkInGovTech/01_Projects/Tools/claude-telegram-relay

# Ensure env is loaded
set -a; source .env; set +a

bun run routines/tro-monthly-update.ts --force 2>&1 | tee /tmp/tro-pipeline.log
```

Watch for these log lines in order:

```
[Phase 1] Fetching GitLab data for group 96143...
[Phase 1] DONE — N MRs, M issues, K milestones
[Phase 2] Sending kickoff message to Telegram...
[Phase 3] Q&A window open — waiting for context answers...
```

On Telegram: reply to the questions. Then watch for:

```
[Phase 3] Q&A complete — proceeding with PPTX assembly
[Phase 4] Generating PPTX...
[Phase 5] Sending completion message...
Pipeline complete.
```

**PASS:** All 5 phase markers appear, Telegram receives kickoff + completion messages, `.pptx` file written to the monthly updates workspace.
**FAIL:** Check `/tmp/tro-pipeline.log` for the first ERROR line and refer to the isolated step above.

---

## Step 11 — Double-spawn guard

Confirms that a second `/monthly_update` during an active Q&A is rejected.

```bash
cd /Users/furi/Documents/WorkInGovTech/01_Projects/Tools/claude-telegram-relay
set -a; source .env; set +a

# Activate the Q&A flag manually (simulates an in-flight pipeline)
bun -e "
import { setTROQAActive } from './src/tro/troQAState.ts';
setTROQAActive(parseInt(process.env.TELEGRAM_USER_ID!), 'test Q');
console.log('Flag set — Q&A window simulated as active');
"

# Now simulate the guard check that botCommands.ts performs
bun -e "
import { isTROQAActive } from './src/tro/troQAState.ts';
const chatId = parseInt(process.env.TELEGRAM_USER_ID!);
if (isTROQAActive(chatId)) {
  console.log('PASS  double-spawn guard fired — would reject /monthly_update');
} else {
  console.log('FAIL  guard did not fire');
}
"

# Clean up
bun -e "
import { clearTROQAActive } from './src/tro/troQAState.ts';
clearTROQAActive();
console.log('Flag cleared');
"
```

**PASS:** `PASS  double-spawn guard fired`.
**FAIL:** Flag not being read → check `logs/tro-qa-active.json` path and file permissions.

---

## Quick reference — run order

| Step | What it tests | External call? | Safe to repeat? |
|------|--------------|---------------|-----------------|
| 1    | Env vars present | No | Yes |
| 2    | GitLab token valid | GitLab | Yes |
| 3    | Group 96143 readable | GitLab | Yes |
| 4    | MRs fetch + pagination | GitLab | Yes |
| 5    | Issues fetch | GitLab | Yes |
| 6    | Projects fetch | GitLab | Yes |
| 7    | Bot can send message | Telegram | Yes |
| 8    | Q&A state flag logic | No | Yes |
| 9    | PPTX generator script | No | Yes |
| 10   | Full pipeline (force) | GitLab + Telegram | **Once per test session** |
| 11   | Double-spawn guard | No | Yes |

Run Steps 1–9 first (all idempotent, no side effects beyond a single Telegram message in Step 7).
Run Step 10 only when Steps 1–9 all pass.
