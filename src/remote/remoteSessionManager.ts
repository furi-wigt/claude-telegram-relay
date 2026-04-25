// src/remote/remoteSessionManager.ts
import { readFileSync, writeFileSync, renameSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface RemoteSession {
  name: string;
  pid: number;
  dir: string;
  specPath?: string;
  sessionUrl?: string;
  permissionMode?: string;
  startedAt: string;
  chatId: number;
  threadId?: number | null;
}

function getStateFilePath(): string {
  return (
    process.env.REMOTE_SESSION_STATE_FILE ??
    join(homedir(), ".claude-relay", "remote-sessions.json")
  );
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readStateFile(): RemoteSession | null {
  const path = getStateFilePath();
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RemoteSession;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[RemoteSessionManager] state file corrupt — ignoring");
    }
    return null;
  }
}

export function writeStateFile(session: RemoteSession): void {
  const path = getStateFilePath();
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(session, null, 2));
  renameSync(tmp, path);
}

export function clearStateFile(): void {
  const path = getStateFilePath();
  try { unlinkSync(path); } catch { /* already gone */ }
}

/** Read state file + probe PID. Returns null if no session or stale (auto-clears stale). */
export function getStatus(): RemoteSession | null {
  const stored = readStateFile();
  if (!stored) return null;
  if (!isAlive(stored.pid)) {
    clearStateFile();
    return null;
  }
  return stored;
}

export async function start(_opts: {
  dir: string;
  specPath?: string;
  permissionMode: string;
  chatId: number;
  threadId?: number | null;
}): Promise<{ name: string; sessionUrl: string }> {
  throw new Error("not yet implemented");
}

export async function stop(): Promise<void> {
  throw new Error("not yet implemented");
}

export function cleanup(): void {
  clearStateFile();
}
