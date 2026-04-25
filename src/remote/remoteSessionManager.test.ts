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
  test("returns null when state file does not exist", async () => {
    const { getStatus } = await import("./remoteSessionManager.ts");
    expect(getStatus()).toBeNull();
  });

  test("returns null and logs warning for corrupt state file", async () => {
    await writeFile(stateFile, "not json");
    const { getStatus } = await import("./remoteSessionManager.ts");
    expect(getStatus()).toBeNull();
  });

  test("returns null when stored PID is dead (stale)", async () => {
    const stale = {
      name: "jarvis-1", pid: 99999999, dir: "/tmp",
      startedAt: new Date().toISOString(), chatId: -1,
    };
    await writeFile(stateFile, JSON.stringify(stale));
    const { getStatus } = await import("./remoteSessionManager.ts");
    expect(getStatus()).toBeNull();
  });

  test("returns session when stored PID is alive (our own process)", async () => {
    const alive = {
      name: "jarvis-1", pid: process.pid, dir: "/tmp",
      startedAt: new Date().toISOString(), chatId: -1,
    };
    await writeFile(stateFile, JSON.stringify(alive));
    const { getStatus } = await import("./remoteSessionManager.ts");
    const s = getStatus();
    expect(s).not.toBeNull();
    expect(s!.name).toBe("jarvis-1");
    expect(s!.pid).toBe(process.pid);
  });
});
