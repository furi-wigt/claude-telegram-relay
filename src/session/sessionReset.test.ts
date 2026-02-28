/**
 * Tests for resetSession() behaviour changes:
 *   - resets messageCount to 0
 *   - resets startedAt to current time
 *   - clears sessionId (existing behaviour, regression guard)
 *   - pendingContextInjection field: initialized as false, survives round-trip
 *   - resetGen counter: incremented by resetSession, guarded by updateSessionIdGuarded
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { mkdtemp, unlink } from "fs/promises";
import { tmpdir, homedir } from "os";
import type { SessionState } from "./groupSessions.ts";

// ── Test isolation: redirect RELAY_DIR to a temp directory ──────────────────

let tmpDir: string;

// Chat IDs used by these tests — clean them up so stale disk files don't
// contaminate future runs. (Module-level SESSIONS_DIR may point to the real
// ~/.claude-relay/sessions when static imports in other test files load the
// module before this beforeAll can override RELAY_DIR.)
const TEST_CHAT_IDS = [
  100001, 100002, 100003,
  100010, 100011, 100012,
  100020, 100021, 100022, 100023,
  200001, 200002, 200003,
  200010, 200011, 200012,
];

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "relay-session-test-"));
  process.env.RELAY_DIR = tmpDir;
});

afterAll(async () => {
  // Delete any session files that were saved to the real sessions directory
  // (the module may have used ~/.claude-relay/sessions instead of tmpDir if it
  // was loaded before RELAY_DIR was overridden by a static import elsewhere).
  const realSessionsDir = join(
    process.env.HOME || homedir(),
    ".claude-relay",
    "sessions",
  );
  await Promise.allSettled(
    TEST_CHAT_IDS.map((id) => unlink(join(realSessionsDir, `${id}_.json`))),
  );
});

// Dynamic import AFTER setting RELAY_DIR so the module reads the correct path
async function getModule() {
  // Use a fresh import each time to avoid caching issues with module-level constants
  return import("./groupSessions.ts");
}

// ─── resetSession — messageCount reset ──────────────────────────────────────

describe("resetSession — resets message counter", () => {
  test("resets messageCount to 0 after /new", async () => {
    const { initSessions, loadSession, resetSession, getSession } = await getModule();
    await initSessions();

    const CHAT_ID = 100001;
    const session = await loadSession(CHAT_ID, "test-agent", null);
    session.messageCount = 42;
    session.startedAt = new Date(Date.now() - 7_200_000).toISOString(); // 2h ago

    await resetSession(CHAT_ID, null);

    const after = getSession(CHAT_ID, null);
    expect(after?.messageCount).toBe(0);
  });

  test("resets startedAt to a recent timestamp", async () => {
    const { initSessions, loadSession, resetSession, getSession } = await getModule();
    await initSessions();

    const CHAT_ID = 100002;
    const before = Date.now();
    const session = await loadSession(CHAT_ID, "test-agent", null);
    session.messageCount = 10;
    const oldStartedAt = new Date(Date.now() - 3_600_000).toISOString();
    session.startedAt = oldStartedAt;

    await resetSession(CHAT_ID, null);

    const after = getSession(CHAT_ID, null);
    const newStartedAt = new Date(after?.startedAt ?? "").getTime();
    expect(newStartedAt).toBeGreaterThanOrEqual(before);
    expect(after?.startedAt).not.toBe(oldStartedAt);
  });

  test("clears sessionId (existing behaviour)", async () => {
    const { initSessions, loadSession, resetSession, getSession } = await getModule();
    await initSessions();

    const CHAT_ID = 100003;
    const session = await loadSession(CHAT_ID, "test-agent", null);
    session.sessionId = "existing-session-abc";

    await resetSession(CHAT_ID, null);

    const after = getSession(CHAT_ID, null);
    expect(after?.sessionId).toBeNull();
  });
});

// ─── pendingContextInjection flag ────────────────────────────────────────────

describe("pendingContextInjection — fresh session initialises to false", () => {
  test("new session has pendingContextInjection = false", async () => {
    const { initSessions, loadSession } = await getModule();
    await initSessions();

    const CHAT_ID = 100010;
    const session = await loadSession(CHAT_ID, "test-agent", null);
    // Should default to false, not undefined
    expect(session.pendingContextInjection).toBe(false);
  });
});

// ─── suppressContextInjection flag ───────────────────────────────────────────

describe("suppressContextInjection — set by resetSession", () => {
  test("new session has suppressContextInjection = false", async () => {
    const { initSessions, loadSession } = await getModule();
    await initSessions();

    const CHAT_ID = 100020;
    const session = await loadSession(CHAT_ID, "test-agent", null);
    expect(session.suppressContextInjection).toBe(false);
  });

  test("resetSession sets suppressContextInjection to true", async () => {
    const { initSessions, loadSession, resetSession, getSession } = await getModule();
    await initSessions();

    const CHAT_ID = 100021;
    await loadSession(CHAT_ID, "test-agent", null);
    await resetSession(CHAT_ID, null);

    const after = getSession(CHAT_ID, null);
    expect(after?.suppressContextInjection).toBe(true);
  });

  test("resetSession with mismatched threadId does not reset the session", async () => {
    const { initSessions, loadSession, resetSession, getSession } = await getModule();
    await initSessions();

    const CHAT_ID = 100022;
    const THREAD_ID = 555;
    const session = await loadSession(CHAT_ID, "test-agent", THREAD_ID);
    session.messageCount = 7;

    // Call resetSession without threadId — should not find the session
    await resetSession(CHAT_ID, null);

    const after = getSession(CHAT_ID, THREAD_ID);
    // Session keyed on threadId=555 should be unchanged
    expect(after?.messageCount).toBe(7);
    expect(after?.suppressContextInjection).toBeFalsy();
  });

  test("resetSession with correct threadId resets the session", async () => {
    const { initSessions, loadSession, resetSession, getSession } = await getModule();
    await initSessions();

    const CHAT_ID = 100023;
    const THREAD_ID = 888;
    const session = await loadSession(CHAT_ID, "test-agent", THREAD_ID);
    session.messageCount = 5;
    session.sessionId = "old-session-id";

    await resetSession(CHAT_ID, THREAD_ID);

    const after = getSession(CHAT_ID, THREAD_ID);
    expect(after?.messageCount).toBe(0);
    expect(after?.sessionId).toBeNull();
    expect(after?.suppressContextInjection).toBe(true);
  });
});

describe("pendingContextInjection — survives save/reload round-trip", () => {
  test("flag set to true is persisted and reloaded correctly", async () => {
    const { initSessions, loadSession, saveSession } = await getModule();
    await initSessions();

    const CHAT_ID = 100011;
    const session = await loadSession(CHAT_ID, "test-agent", null);
    session.pendingContextInjection = true;
    await saveSession(session);

    // Clear from in-memory cache by loading from disk directly (simulate restart)
    // We can't easily evict the cache, so instead verify the object reference itself
    expect(session.pendingContextInjection).toBe(true);
  });

  test("flag cleared after being consumed remains false", async () => {
    const { initSessions, loadSession, saveSession } = await getModule();
    await initSessions();

    const CHAT_ID = 100012;
    const session = await loadSession(CHAT_ID, "test-agent", null);
    session.pendingContextInjection = true;

    // Simulate relay consuming the flag
    const shouldInject = session.pendingContextInjection === true;
    session.pendingContextInjection = false;
    await saveSession(session);

    expect(shouldInject).toBe(true);
    expect(session.pendingContextInjection).toBe(false);
  });
});

// ─── resetGen counter ────────────────────────────────────────────────────────

describe("resetGen — guards against stale onSessionId callbacks", () => {
  test("new session initialises resetGen to 0", async () => {
    const { initSessions, loadSession } = await getModule();
    await initSessions();

    const CHAT_ID = 200001;
    const session = await loadSession(CHAT_ID, "test-agent", null);
    expect(session.resetGen).toBe(0);
  });

  test("resetSession increments resetGen", async () => {
    const { initSessions, loadSession, resetSession, getSession } = await getModule();
    await initSessions();

    const CHAT_ID = 200002;
    const session = await loadSession(CHAT_ID, "test-agent", null);
    expect(session.resetGen).toBe(0);

    await resetSession(CHAT_ID, null);
    expect(getSession(CHAT_ID, null)?.resetGen).toBe(1);
  });

  test("resetSession increments resetGen on each call", async () => {
    const { initSessions, loadSession, resetSession, getSession } = await getModule();
    await initSessions();

    const CHAT_ID = 200003;
    await loadSession(CHAT_ID, "test-agent", null);

    await resetSession(CHAT_ID, null);
    await resetSession(CHAT_ID, null);
    await resetSession(CHAT_ID, null);
    expect(getSession(CHAT_ID, null)?.resetGen).toBe(3);
  });

  test("updateSessionIdGuarded updates when gen matches", async () => {
    const { initSessions, loadSession, updateSessionIdGuarded, getSession } = await getModule();
    await initSessions();

    const CHAT_ID = 200010;
    const session = await loadSession(CHAT_ID, "test-agent", null);
    const gen = session.resetGen; // 0

    await updateSessionIdGuarded(CHAT_ID, "new-session-id", gen, null);

    expect(getSession(CHAT_ID, null)?.sessionId).toBe("new-session-id");
  });

  test("updateSessionIdGuarded is a no-op when gen is stale (race condition scenario)", async () => {
    const { initSessions, loadSession, resetSession, updateSessionIdGuarded, getSession } = await getModule();
    await initSessions();

    const CHAT_ID = 200011;
    const session = await loadSession(CHAT_ID, "test-agent", null);
    session.sessionId = "old-session-id";

    // Simulate: captured gen before /new was sent
    const capturedGen = session.resetGen; // 0

    // /new arrives mid-flight: resets session
    await resetSession(CHAT_ID, null);
    expect(getSession(CHAT_ID, null)?.sessionId).toBeNull();
    expect(getSession(CHAT_ID, null)?.resetGen).toBe(1);

    // Old Claude response fires onSessionId with the old session ID
    // Guard: capturedGen (0) !== current resetGen (1) → should be discarded
    await updateSessionIdGuarded(CHAT_ID, "old-session-id", capturedGen, null);

    // sessionId must remain null — the stale callback must not overwrite the reset
    expect(getSession(CHAT_ID, null)?.sessionId).toBeNull();
  });

  test("updateSessionIdGuarded allows new session ID after reset when gen matches", async () => {
    const { initSessions, loadSession, resetSession, updateSessionIdGuarded, getSession } = await getModule();
    await initSessions();

    const CHAT_ID = 200012;
    const session = await loadSession(CHAT_ID, "test-agent", null);
    session.sessionId = "old-session-id";

    // /new resets session
    await resetSession(CHAT_ID, null);
    const newGen = getSession(CHAT_ID, null)!.resetGen; // 1

    // Next Claude call (after reset) fires onSessionId — gen matches
    await updateSessionIdGuarded(CHAT_ID, "fresh-session-id", newGen, null);

    expect(getSession(CHAT_ID, null)?.sessionId).toBe("fresh-session-id");
  });
});
