// src/remote/remoteSessionManager.ts
import { readFileSync, writeFileSync, renameSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { spawn } from "child_process";
import type { Readable } from "stream";
import { buildClaudeEnv, getClaudePath } from "../claude-process.ts";

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

const SESSION_URL_RE = /https:\/\/claude\.ai\/code[^\s]*/;

export function waitForSessionUrl(
  stdout: Readable,
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("remote-control did not emit a session URL within the timeout"));
    }, timeoutMs);

    let buf = "";
    stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const match = SESSION_URL_RE.exec(buf);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });

    stdout.on("end", () => {
      clearTimeout(timer);
      reject(new Error("remote-control process exited before emitting a session URL"));
    });
  });
}

export async function start(opts: {
  dir: string;
  specPath?: string;
  permissionMode: string;
  chatId: number;
  threadId?: number | null;
}): Promise<{ name: string; sessionUrl: string }> {
  // Guard: block if a live session already exists
  const existing = readStateFile();
  if (existing) {
    if (isAlive(existing.pid)) {
      throw new Error(
        `Session already running: ${existing.name} (PID ${existing.pid}). Use /code stop first.`
      );
    }
    // Stale — auto-clean
    clearStateFile();
  }

  const sessionName = `jarvis-${Date.now()}`;

  // Strip API key — claude --remote-control requires claude.ai OAuth
  const env = { ...buildClaudeEnv(), ANTHROPIC_API_KEY: undefined };

  const child = spawn(
    getClaudePath(),
    [
      "--remote-control",
      "--permission-mode", opts.permissionMode,
      "--name", sessionName,
    ],
    {
      cwd: opts.dir,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: env as Record<string, string>,
    }
  );

  let sessionUrl: string;
  try {
    sessionUrl = await new Promise<string>((resolve, reject) => {
      child.once("error", (err) => reject(err));
      child.once("exit", (code, signal) => {
        if (code !== 0 || signal) {
          reject(new Error(
            `claude exited early (code=${code} signal=${signal}). ` +
            `Is remote-control authenticated via claude.ai?`
          ));
        }
      });
      waitForSessionUrl(child.stdout!, 15_000).then(resolve, reject);
    });
  } catch (err) {
    try { child.kill("SIGTERM"); } catch { /* already dead */ }
    throw err;
  }

  // Detach — process survives relay restarts
  child.stdout!.destroy();
  child.stderr!.destroy();
  child.unref();

  writeStateFile({
    name: sessionName,
    pid: child.pid!,
    dir: opts.dir,
    specPath: opts.specPath,
    sessionUrl,
    permissionMode: opts.permissionMode,
    startedAt: new Date().toISOString(),
    chatId: opts.chatId,
    threadId: opts.threadId ?? null,
  });

  return { name: sessionName, sessionUrl };
}

export async function stop(): Promise<void> {
  const stored = readStateFile();
  if (!stored) return;
  if (isAlive(stored.pid)) {
    try {
      process.kill(stored.pid, "SIGTERM");
    } catch {
      // already gone between check and kill
    }
  }
  clearStateFile();
}

export function cleanup(): void {
  clearStateFile();
}
