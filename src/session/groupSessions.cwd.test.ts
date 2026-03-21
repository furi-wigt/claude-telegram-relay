/**
 * Unit tests for per-topic cwd isolation in SessionState.
 *
 * Tests the new `cwd` and `activeCwd` fields and the `setTopicCwd` / `lockActiveCwd` helpers.
 * Run: bun test src/session/groupSessions.cwd.test.ts
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { tmpdir } from "os";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";

// We need a real temp directory on disk so path validation tests work.
let testSessionsDir: string;

// Override RELAY_DIR before importing the module so it writes to our temp dir.
// Must be set before the module is first imported.
beforeEach(async () => {
  testSessionsDir = await mkdtemp(join(tmpdir(), "relay-cwd-test-"));
  process.env.RELAY_DIR = testSessionsDir;
});

// Dynamically import after env is set so each test gets a fresh module instance.
async function getModule() {
  // Bun caches modules — use a cache-busting query param workaround isn't possible,
  // so tests share module state. We reset via initSessions + direct state manipulation.
  return await import("./groupSessions.ts");
}

describe("setTopicCwd", () => {
  test("updates session.cwd and persists to disk", async () => {
    const { initSessions, loadSession, setTopicCwd } = await getModule();
    await initSessions();

    await loadSession(100, "general-assistant", null);
    await setTopicCwd(100, null, "/tmp");

    const { loadSession: reload } = await getModule();
    const session = await reload(100, "general-assistant", null);
    expect(session.cwd).toBe("/tmp");
  });

  test("rejects non-existent path", async () => {
    const { initSessions, loadSession, setTopicCwd } = await getModule();
    await initSessions();

    await loadSession(200, "general-assistant", null);
    await expect(setTopicCwd(200, null, "/this/path/does/not/exist/ever")).rejects.toThrow(
      "Path does not exist"
    );
  });

  test("passing undefined clears cwd (reset to default)", async () => {
    const { initSessions, loadSession, setTopicCwd } = await getModule();
    await initSessions();

    await loadSession(300, "general-assistant", null);
    await setTopicCwd(300, null, "/tmp");
    await setTopicCwd(300, null, undefined);

    const session = await loadSession(300, "general-assistant", null);
    expect(session.cwd).toBeUndefined();
  });

  test("scoped per topic: different threadIds have independent cwds", async () => {
    const { initSessions, loadSession, setTopicCwd } = await getModule();
    await initSessions();

    await loadSession(400, "general-assistant", 1);
    await loadSession(400, "general-assistant", 2);

    await setTopicCwd(400, 1, "/tmp");

    const s1 = await loadSession(400, "general-assistant", 1);
    const s2 = await loadSession(400, "general-assistant", 2);

    expect(s1.cwd).toBe("/tmp");
    expect(s2.cwd).toBeUndefined();
  });
});

describe("lockActiveCwd", () => {
  test("sets activeCwd from cwd when session has no sessionId", async () => {
    const { initSessions, loadSession, setTopicCwd, lockActiveCwd } = await getModule();
    await initSessions();

    await loadSession(500, "general-assistant", null);
    await setTopicCwd(500, null, "/tmp");
    await lockActiveCwd(500, null, "/default-project");

    const session = await loadSession(500, "general-assistant", null);
    expect(session.activeCwd).toBe("/tmp");
  });

  test("falls back to projectDir when session.cwd is not set", async () => {
    const { initSessions, loadSession, lockActiveCwd } = await getModule();
    await initSessions();

    await loadSession(600, "general-assistant", null);
    await lockActiveCwd(600, null, "/default-project");

    const session = await loadSession(600, "general-assistant", null);
    expect(session.activeCwd).toBe("/default-project");
  });

  test("does not change activeCwd when session has an active sessionId", async () => {
    const { initSessions, loadSession, setTopicCwd, lockActiveCwd, saveSession } = await getModule();
    await initSessions();

    const session = await loadSession(700, "general-assistant", null);
    session.sessionId = "existing-session-id";
    session.activeCwd = "/original/path";
    await saveSession(session);

    await setTopicCwd(700, null, "/tmp");
    await lockActiveCwd(700, null, "/default-project");

    const updated = await loadSession(700, "general-assistant", null);
    expect(updated.activeCwd).toBe("/original/path");  // unchanged
  });
});
