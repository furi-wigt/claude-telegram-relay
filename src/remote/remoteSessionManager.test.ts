/**
 * Unit tests for RemoteSessionManager — state file read/write + PID probe.
 *
 * Run: bun test src/remote/remoteSessionManager.test.ts
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Readable } from "stream";
import { getStatus, writeStateFile, clearStateFile, waitForSessionUrl, start, stop } from "./remoteSessionManager.ts";

let tmpDir: string;
let stateFile: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "rsm-test-"));
  stateFile = join(tmpDir, "remote-sessions.json");
  process.env.REMOTE_SESSION_STATE_FILE = stateFile;
});

afterEach(async () => {
  delete process.env.REMOTE_SESSION_STATE_FILE;
  await rm(tmpDir, { recursive: true, force: true });
});

describe("RemoteSessionManager.getStatus()", () => {
  test("returns null when state file does not exist", () => {
    expect(getStatus()).toBeNull();
  });

  test("returns null and logs warning for corrupt state file", async () => {
    await writeFile(stateFile, "not json");
    expect(getStatus()).toBeNull();
  });

  test("returns null when stored PID is dead (stale) and clears state file", async () => {
    const stale = {
      name: "jarvis-1", pid: 99999999, dir: "/tmp",
      startedAt: new Date().toISOString(), chatId: -1,
    };
    await writeFile(stateFile, JSON.stringify(stale));
    expect(getStatus()).toBeNull();
    // Stale file should have been auto-cleared
    expect(existsSync(stateFile)).toBe(false);
  });

  test("returns session when stored PID is alive (our own process)", async () => {
    const alive = {
      name: "jarvis-1", pid: process.pid, dir: "/tmp",
      startedAt: new Date().toISOString(), chatId: -1,
    };
    await writeFile(stateFile, JSON.stringify(alive));
    const s = getStatus();
    expect(s).not.toBeNull();
    expect(s!.name).toBe("jarvis-1");
    expect(s!.pid).toBe(process.pid);
  });
});

describe("clearStateFile()", () => {
  test("is a no-op when file does not exist", () => {
    expect(() => clearStateFile()).not.toThrow();
  });

  test("removes the file when it exists", async () => {
    await writeFile(stateFile, "{}");
    clearStateFile();
    expect(existsSync(stateFile)).toBe(false);
  });
});

describe("RemoteSessionManager.start() — guard", () => {
  test("throws 'Session already running' when a live PID exists in state file", async () => {
    writeStateFile({
      name: "jarvis-running",
      pid: process.pid, // alive — our own PID
      dir: "/tmp",
      startedAt: new Date().toISOString(),
      chatId: -1,
      threadId: null,
    });
    await expect(
      start({ dir: "/tmp", permissionMode: "plan", chatId: -1 })
    ).rejects.toThrow("Session already running");
  });

  test("auto-cleans stale PID before attempting spawn", async () => {
    writeStateFile({
      name: "jarvis-stale",
      pid: 99999999, // dead
      dir: "/tmp",
      startedAt: new Date().toISOString(),
      chatId: -1,
      threadId: null,
    });
    // Guard should NOT throw "already running" — stale session was cleared.
    // It will fail on spawn (claude not found or timeout) but NOT due to the guard.
    const err = await start({ dir: "/tmp", permissionMode: "plan", chatId: -1 }).catch((e: Error) => e);
    expect((err as Error).message).not.toContain("already running");
    // State file should be cleared (stale was auto-cleaned, spawn failed before writing new state)
    expect(existsSync(stateFile)).toBe(false);
  });
});

describe("RemoteSessionManager.stop()", () => {
  test("resolves without error when no session exists", async () => {
    await expect(stop()).resolves.toBeUndefined();
  });

  test("resolves and clears state file for stale PID session", async () => {
    writeStateFile({
      name: "jarvis-stale", pid: 99999999, dir: "/tmp",
      startedAt: new Date().toISOString(), chatId: -1, threadId: null,
    });
    await stop();
    expect(existsSync(stateFile)).toBe(false);
  });

  test("clears state when PID is live — spawns a real child to verify SIGTERM path", async () => {
    // Spawn a long-lived child so we can safely send SIGTERM without killing the test runner.
    const { spawn } = await import("child_process");
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    const livePid = child.pid!;

    writeStateFile({
      name: "jarvis-live", pid: livePid, dir: "/tmp",
      startedAt: new Date().toISOString(), chatId: -1, threadId: null,
    });
    await stop();
    // State file must be cleared regardless of whether process is alive or dead.
    expect(existsSync(stateFile)).toBe(false);
    // Clean up in case SIGTERM didn't land (test isolation).
    try { process.kill(livePid, "SIGKILL"); } catch { /* already gone */ }
  });
});

describe("waitForSessionUrl", () => {
  test("resolves with URL from stream", async () => {
    const stream = new Readable({ read() {} });
    const promise = waitForSessionUrl(stream, 5000);
    stream.push("Claude Code remote control started\nhttps://claude.ai/code?session=abc123\n");
    stream.push(null);
    await expect(promise).resolves.toBe("https://claude.ai/code?session=abc123");
  });

  test("rejects after timeout when no URL emitted", async () => {
    const stream = new Readable({ read() {} });
    const promise = waitForSessionUrl(stream, 100); // 100ms timeout for fast test
    await expect(promise).rejects.toThrow("did not emit a session URL");
  });
});
