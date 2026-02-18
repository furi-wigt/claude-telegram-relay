# Plan: Fix 10 Remaining Test Failures

**Created:** 2026-02-18
**Branch:** question_UI
**Scope:** `src/utils/progressIndicator.test.ts` (4 failures), `src/coding/sessionRunner.test.ts` (6 failures)

---

## Summary

After fixing the question UI and shortTermMemory bugs (commit `b878e74`), 10 tests remain failing. These are pre-existing failures unrelated to the question UI work. Root causes are fully understood:

- **ProgressIndicator (4)**: Test constants mismatch actual source constants
- **SessionRunner (6)**: `mock()` on `fs/promises` in earlier tests pollutes later tests; real-timer timing instability

---

## Part 1: ProgressIndicator — 4 Failures

**File:** `src/utils/progressIndicator.test.ts`

### Root Cause

The test was written against different constant values than what the source currently uses.

| Constant | Test Assumes | Source Has | Env Var |
|---|---|---|---|
| `UPDATE_INTERVAL_MS` | 120 000 ms | 60 000 ms | `PROGRESS_UPDATE_INTERVAL_MS` |
| finish delete delay | 3 000 ms | 5 000 ms | hardcoded |
| `EVENT_BUFFER_SIZE` | 5 | 10 | `PROGRESS_EVENT_BUFFER_SIZE` |

### Failing Tests

1. **`editMessageText called after edit interval elapses`**
   - Test advances `120001 ms`, expects `editMessageText` called 1 time
   - `UPDATE_INTERVAL_MS = 60000` → interval fires at 60s **and** 120s → 2 calls
   - **Fix**: Change `advanceTime(120001)` → `advanceTime(60001)`

2. **`update without immediate flag does not trigger editMessageText`**
   - Test advances `30000 ms`, calls update, advances `90001 ms` more (total 120001ms)
   - Same double-fire issue
   - **Fix**: Advance only `30001 ms` after the update call (total < 60001ms past the last update triggers 1 fire)
   - Or: expect `toHaveBeenCalledTimes(2)` if the test intent is "fires on interval"

3. **`finish() schedules a deleteMessage call after 3 seconds`**
   - Test calls `finish()`, advances `3001 ms`, expects `deleteMessage` called
   - Source: `setTimeout(..., 5000)` → 3001ms is not enough
   - **Fix**: Change `advanceTime(3001)` → `advanceTime(5001)`

4. **`buffer caps at 5 entries, evicting oldest`**
   - Test pushes 6 events, expects event 1 (oldest) to be evicted
   - `EVENT_BUFFER_SIZE = 10` → buffer holds all 6, event 1 still present
   - **Fix**: Push 11 events and assert that event 1 is gone (cap at 10), OR set `process.env.PROGRESS_EVENT_BUFFER_SIZE = "5"` in `beforeEach` of that test

### Implementation Steps

1. Read `src/utils/progressIndicator.test.ts` to locate exact line numbers
2. Fix 1 and 2: change `advanceTime` calls from 120001 to 60001 (and adjust intermediate advances proportionally)
3. Fix 3: change `advanceTime(3001)` to `advanceTime(5001)` for finish test
4. Fix 4: Either:
   - Push 11 events and assert event[0] is evicted (preferred — tests actual cap)
   - Or set env var in `beforeEach`: `process.env.PROGRESS_EVENT_BUFFER_SIZE = "5"` and reset in `afterEach`
5. Run `bun test src/utils/progressIndicator.test.ts` — all should pass

---

## Part 2: SessionRunner — 6 Failures

**File:** `src/coding/sessionRunner.test.ts`
**Key observation**: All 105 tests pass in isolation (`bun test src/coding/sessionRunner.test.ts`). Failures only appear in the full suite run — test pollution.

### Failing Tests

**Group A: `pollInbox` — 4 tests** (lines ~1441–1545)

Tests write a real JSON file to `homedir()/.claude/teams/<testTeamName>/inboxes/team-lead.json`, then call `pollInbox(teamName, skipCount)`. In full suite, all return 0 messages instead of the expected count.

**Root Cause**: `sessionRunner.test.ts` itself heavily uses `mock()` to replace `fs/promises` functions at the top of its own `beforeEach` blocks. When test files run in the same bun process, the `mock()` calls on `fs/promises` module from earlier describe blocks within the same file can leak. The `pollInbox` tests at the bottom of the file might be picking up mocked `readFile` that returns undefined/empty.

**Fix A — Add explicit `mock.restore()` before pollInbox tests**:
```typescript
describe("pollInbox", () => {
  beforeEach(() => {
    mock.restore(); // Clear any lingering fs/promises mocks
  });
  // ... existing tests unchanged
});
```

**Fix B — Use `afterEach` to restore in all mock-heavy describe blocks above**:
In every `describe` block that calls `mock("node:fs/promises", ...)`, add:
```typescript
afterEach(() => {
  mock.restore();
});
```

**Recommended**: Fix B — restores mocks after each test, preventing bleed.

**Group B: `discoverActualTeamName` — 2 tests** (lines ~1593–1641)

Tests use real `setTimeout` with a 5000ms timeout passed as `options.timeout`. They fail with timeout exceeded.

**Root Cause**: The tests pass `{ pollIntervalMs: 100, timeout: 5000 }`. The `discoverActualTeamName` implementation polls every `pollIntervalMs` and gives up after `timeout` ms. With real timers in a loaded test suite, scheduling jitter causes the timeout to fire before the final poll resolves, missing the team directory by ~1ms.

**Fix**: Pass a shorter `pollIntervalMs` and longer relative timeout to reduce flakiness, OR mock the directory scan:

```typescript
// Before (flaky):
const result = await discoverActualTeamName(knownTeams, { pollIntervalMs: 100, timeout: 5000 });

// After (stable):
const result = await discoverActualTeamName(knownTeams, { pollIntervalMs: 10, timeout: 2000 });
```

The test creates the directory synchronously before calling `discoverActualTeamName`, so with `pollIntervalMs: 10` the first poll fires in 10ms and finds the directory immediately — no timing race.

### Implementation Steps

1. Read `src/coding/sessionRunner.test.ts` to find exact describe blocks that mock `fs/promises`
2. Add `afterEach(() => { mock.restore(); })` inside each `describe` block that uses `mock("node:fs/promises", ...)`
3. Find the `discoverActualTeamName` test calls and change `pollIntervalMs: 100` → `pollIntervalMs: 10`
4. Run `bun test src/coding/sessionRunner.test.ts` in isolation → confirm still 105 pass
5. Run full suite `bun test` → confirm the 6 now also pass

---

## Acceptance Criteria

- [ ] `bun test src/utils/progressIndicator.test.ts` — all pass (was 4 failing)
- [ ] `bun test src/coding/sessionRunner.test.ts` — all pass in isolation (was already true)
- [ ] `bun test` (full suite) — 0 failures (was 10 failing)
- [ ] No existing passing tests broken

---

## Out of Scope

- Do not change source constants (`UPDATE_INTERVAL_MS`, `EVENT_BUFFER_SIZE`, delete delay) — the fix belongs in the tests
- Do not change the `pollInbox` or `discoverActualTeamName` implementations — they are correct; only the test setup is broken
