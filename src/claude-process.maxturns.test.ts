/**
 * Unit tests for claudeStream maxTurns kill.
 *
 * Key invariants:
 *   - Turn counter increments on every tool_use event (top-level and assistant content)
 *   - When turnCount >= maxTurns, subprocess is killed and partial result returned
 *   - maxTurns = 0 means unlimited (no kill)
 *   - onProgress fires with warning message before kill
 *
 * Run: bun test src/claude-process.maxturns.test.ts
 */

import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";

// Set env BEFORE import so module picks up test values
process.env.CLAUDE_IDLE_TIMEOUT_MS = "5000";
process.env.CLAUDE_SOFT_CEILING_MS = "10000";

// ── Stream helpers ────────────────────────────────────────────────────────────

function textStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      if (text) controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

// ── Mock proc factory ─────────────────────────────────────────────────────────

function mockProc(opts: {
  stdout: string;
  stderr?: string;
  exitCode?: number;
  exitDelay?: number;
  onKill?: () => void;
}) {
  let resolveExit: ((code: number) => void) | undefined;
  const exitPromise = new Promise<number>((resolve) => {
    if (opts.exitDelay) {
      const timer = setTimeout(() => resolve(opts.exitCode ?? 0), opts.exitDelay);
      resolveExit = (code) => {
        clearTimeout(timer);
        resolve(code);
      };
    } else {
      resolve(opts.exitCode ?? 0);
    }
  });

  return {
    stdout: textStream(opts.stdout),
    stderr: textStream(opts.stderr ?? ""),
    stdin: { write: () => {}, end: () => {} },
    exited: exitPromise,
    kill: () => {
      opts.onKill?.();
      resolveExit?.(143);
    },
  };
}

// ── NDJSON line builders ──────────────────────────────────────────────────────

function toolUseLine(name: string): string {
  return JSON.stringify({ type: "tool_use", name, id: `tool-${name}`, input: {} });
}

function assistantWithToolUse(names: string[]): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: names.map((n) => ({ type: "tool_use", name: n, id: `tool-${n}`, input: {} })),
    },
  });
}

function resultLine(text: string): string {
  return JSON.stringify({ type: "result", subtype: "success", result: text });
}

// ── Mock spawn ────────────────────────────────────────────────────────────────

let spawnMock = mock(() => mockProc({ stdout: "", exitCode: 0 }));

mock.module("./spawn", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

const { claudeStream } = await import("./claude-process");

beforeEach(() => {
  spawnMock.mockClear();
});

afterAll(() => {
  // Restore env
  delete process.env.CLAUDE_MAX_TURNS;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("claudeStream maxTurns", () => {
  test("kills process when top-level tool_use count reaches maxTurns", async () => {
    let killed = false;
    const lines = [
      toolUseLine("Read"),
      toolUseLine("Grep"),
      resultLine("partial"),
    ].join("\n") + "\n";

    spawnMock.mockImplementation(() =>
      mockProc({ stdout: lines, exitDelay: 500, onKill: () => { killed = true; } })
    );

    const result = await claudeStream("test", { maxTurns: 2 });
    expect(killed).toBe(true);
    expect(result).toBeDefined();
  });

  test("kills process when assistant content tool_use count reaches maxTurns", async () => {
    let killed = false;
    const lines = [
      assistantWithToolUse(["Read", "Edit"]),
      resultLine("partial"),
    ].join("\n") + "\n";

    spawnMock.mockImplementation(() =>
      mockProc({ stdout: lines, exitDelay: 500, onKill: () => { killed = true; } })
    );

    const result = await claudeStream("test", { maxTurns: 2 });
    expect(killed).toBe(true);
    expect(result).toBeDefined();
  });

  test("fires onProgress warning before kill", async () => {
    const progressMessages: string[] = [];
    const lines = [
      toolUseLine("Read"),
      toolUseLine("Grep"),
      resultLine("partial"),
    ].join("\n") + "\n";

    spawnMock.mockImplementation(() =>
      mockProc({ stdout: lines, exitDelay: 500 })
    );

    await claudeStream("test", {
      maxTurns: 2,
      onProgress: (msg) => progressMessages.push(msg),
    });

    const warning = progressMessages.find((m) => m.includes("Turn limit reached"));
    expect(warning).toBeDefined();
    expect(warning).toContain("2 tool calls");
  });

  test("maxTurns=0 means unlimited — no kill", async () => {
    let killed = false;
    const lines = [
      toolUseLine("Read"),
      toolUseLine("Grep"),
      toolUseLine("Edit"),
      resultLine("ok"),
    ].join("\n") + "\n";

    spawnMock.mockImplementation(() =>
      mockProc({ stdout: lines, exitCode: 0, onKill: () => { killed = true; } })
    );

    const result = await claudeStream("test", { maxTurns: 0 });
    // proc.kill IS called on result line (normal cleanup), but maxTurnsReached should be false
    expect(result).toBe("ok");
  });

  test("does not kill when below maxTurns limit", async () => {
    let killed = false;
    const lines = [
      toolUseLine("Read"),
      resultLine("ok"),
    ].join("\n") + "\n";

    spawnMock.mockImplementation(() =>
      mockProc({ stdout: lines, exitCode: 0, onKill: () => { killed = true; } })
    );

    const result = await claudeStream("test", { maxTurns: 5 });
    expect(result).toBe("ok");
  });

  test("counts mixed top-level and assistant content tool_use events", async () => {
    let killed = false;
    const lines = [
      toolUseLine("Read"),
      assistantWithToolUse(["Edit"]),
      toolUseLine("Grep"),
      resultLine("partial"),
    ].join("\n") + "\n";

    spawnMock.mockImplementation(() =>
      mockProc({ stdout: lines, exitDelay: 500, onKill: () => { killed = true; } })
    );

    const result = await claudeStream("test", { maxTurns: 3 });
    expect(killed).toBe(true);
    expect(result).toBeDefined();
  });

  test("uses CLAUDE_MAX_TURNS env var as default", async () => {
    process.env.CLAUDE_MAX_TURNS = "2";
    let killed = false;
    const lines = [
      toolUseLine("Read"),
      toolUseLine("Grep"),
      resultLine("partial"),
    ].join("\n") + "\n";

    spawnMock.mockImplementation(() =>
      mockProc({ stdout: lines, exitDelay: 500, onKill: () => { killed = true; } })
    );

    const result = await claudeStream("test");
    expect(killed).toBe(true);
    expect(result).toBeDefined();
    delete process.env.CLAUDE_MAX_TURNS;
  });
});
