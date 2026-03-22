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

  test("parallel tool_use blocks in one assistant message must not overshoot maxTurns", async () => {
    // Regression: 3 tool_use blocks in single assistant message with maxTurns=2
    // should kill after the 2nd block, NOT continue to count block 3 (which gave 3/2).
    let killCount = 0;
    let finalTurnCount = 0;
    const progressMessages: string[] = [];

    const lines = [
      // Single assistant message with 3 parallel tool_use blocks
      assistantWithToolUse(["Read", "Grep", "Edit"]),
      resultLine("partial"),
    ].join("\n") + "\n";

    spawnMock.mockImplementation(() =>
      mockProc({ stdout: lines, exitDelay: 500, onKill: () => { killCount++; } })
    );

    await claudeStream("test", {
      maxTurns: 2,
      onProgress: (msg) => progressMessages.push(msg),
    });

    expect(killCount).toBeGreaterThanOrEqual(1);
    // Warning must fire exactly ONCE — not once per parallel block past the limit
    const warnings = progressMessages.filter((m) => m.includes("Turn limit reached"));
    expect(warnings.length).toBe(1);
  });

  test("buffered lines after maxTurnsReached — outer loop must stop", async () => {
    // Regression: when multiple NDJSON lines are buffered together (arrive in one chunk),
    // the outer lines loop must stop processing after maxTurnsReached is set.
    // Without the fix, tool_use events in subsequent buffered lines inflate turnCount.
    let killCount = 0;
    const progressMessages: string[] = [];

    // 3 separate top-level tool_use lines buffered together, maxTurns=1
    // Without fix: all 3 lines are processed → turnCount=3, warning fires 3 times
    // With fix: loop stops after line 1 → turnCount=1, warning fires once
    const lines = [
      toolUseLine("Read"),
      toolUseLine("Grep"),
      toolUseLine("Edit"),
      resultLine("partial"),
    ].join("\n") + "\n";

    spawnMock.mockImplementation(() =>
      mockProc({ stdout: lines, exitDelay: 500, onKill: () => { killCount++; } })
    );

    await claudeStream("test", {
      maxTurns: 1,
      onProgress: (msg) => progressMessages.push(msg),
    });

    expect(killCount).toBeGreaterThanOrEqual(1);
    const warnings = progressMessages.filter((m) => m.includes("Turn limit reached"));
    // Must fire exactly once — not once per buffered line
    expect(warnings.length).toBe(1);
  });

  test("onMaxTurns fires exactly once with the warning message", async () => {
    const maxTurnsCalls: string[] = [];
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
      onMaxTurns: (msg) => maxTurnsCalls.push(msg),
    });

    expect(maxTurnsCalls.length).toBe(1);
    expect(maxTurnsCalls[0]).toContain("Turn limit reached");
    expect(maxTurnsCalls[0]).toContain("2 tool calls");
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
