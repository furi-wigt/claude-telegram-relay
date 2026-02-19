/**
 * Unit tests for claudeStream AbortSignal cancellation support.
 *
 * Tests the NEW `signal` option added to ClaudeStreamOptions.
 *
 * Strategy: mock `./spawn` via mock.module (same pattern as e2e.test.ts)
 * Run: bun test src/claude-process.cancel.test.ts
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

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

/**
 * A controllable stream that can be closed from outside.
 * Used to simulate the stdout pipe closing when proc.kill() is called.
 */
function controllableStream(): {
  stream: ReadableStream<Uint8Array>;
  enqueue: (data: Uint8Array) => void;
  close: () => void;
} {
  let ctrl: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) { ctrl = c; },
  });
  return {
    stream,
    enqueue: (data: Uint8Array) => { try { ctrl.enqueue(data); } catch {} },
    close: () => { try { ctrl.close(); } catch {} },
  };
}

// ── Mock proc factory ─────────────────────────────────────────────────────────

function mockProc(opts: {
  /** stdout as string (immediate), or a controllableStream result for deferred data */
  stdout?: string | { stream: ReadableStream<Uint8Array>; close: () => void };
  stderr?: string;
  exitCode?: number;
  exitDelay?: number;
  onKill?: () => void;
}) {
  let resolveExit: ((code: number) => void) | undefined;
  const exitPromise = new Promise<number>((resolve) => {
    if (opts.exitDelay) {
      const timer = setTimeout(() => resolve(opts.exitCode ?? 0), opts.exitDelay);
      resolveExit = (code: number) => {
        clearTimeout(timer);
        resolve(code);
      };
    } else {
      resolve(opts.exitCode ?? 0);
    }
  });

  let stdout: ReadableStream<Uint8Array>;
  let closeStdout: (() => void) | undefined;

  if (typeof opts.stdout === "string" || opts.stdout === undefined) {
    stdout = textStream((opts.stdout as string) ?? "");
  } else {
    stdout = opts.stdout.stream;
    closeStdout = opts.stdout.close;
  }

  return {
    stdout,
    stderr: textStream(opts.stderr ?? ""),
    exited: exitPromise,
    kill: mock(() => {
      opts.onKill?.();
      // Close stdout so parseStream() reader.read() returns {done:true} — mirrors
      // real subprocess behaviour where killing the process closes its pipes.
      closeStdout?.();
      if (resolveExit) resolveExit(opts.exitCode ?? 143);
    }),
    pid: Math.floor(Math.random() * 99999),
  };
}

// ── NDJSON helpers ───────────────────────────────────────────────────────────

function assistantLine(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  });
}

function resultLine(result: string): string {
  return JSON.stringify({ type: "result", subtype: "success", result });
}

// ── Module mock ───────────────────────────────────────────────────────────────

const spawnMock = mock((..._args: unknown[]) =>
  mockProc({ stdout: resultLine("default") + "\n", exitCode: 0 })
);

mock.module("./spawn", () => ({ spawn: spawnMock }));

const { claudeStream } = await import("./claude-process.ts");

beforeEach(() => {
  spawnMock.mockReset();
});

// ═══════════════════════════════════════════════════════════════
// Suite 1: Backward compatibility — no signal provided
// ═══════════════════════════════════════════════════════════════

describe("claudeStream — no signal (backward compat)", () => {
  test("no signal → returns full result", async () => {
    const ndjson = [assistantLine("working"), resultLine("final answer")].join("\n") + "\n";
    spawnMock.mockImplementation(() => mockProc({ stdout: ndjson, exitCode: 0 }));

    const result = await claudeStream("prompt");
    expect(result).toBe("final answer");
  });

  test("signal: undefined → behaves identically to no signal", async () => {
    const ndjson = resultLine("answer") + "\n";
    spawnMock.mockImplementation(() => mockProc({ stdout: ndjson, exitCode: 0 }));

    const result = await claudeStream("prompt", { signal: undefined });
    expect(result).toBe("answer");
  });

  test("exit 130 still returns partial without throwing", async () => {
    const ndjson = assistantLine("partial text") + "\n";
    spawnMock.mockImplementation(() => mockProc({ stdout: ndjson, exitCode: 130 }));

    const result = await claudeStream("prompt");
    expect(result).toBe("partial text");
  });
});

// ═══════════════════════════════════════════════════════════════
// Suite 2: Signal aborted before claudeStream is called
// ═══════════════════════════════════════════════════════════════

describe("claudeStream — signal already aborted before call", () => {
  test("pre-aborted signal → resolves or rejects quickly without blocking", async () => {
    const controller = new AbortController();
    controller.abort();

    spawnMock.mockImplementation(() =>
      mockProc({ stdout: neverEndingStream(), exitCode: 143, exitDelay: 5000 })
    );

    const start = Date.now();
    await claudeStream("prompt", { signal: controller.signal }).catch(() => {});
    const elapsed = Date.now() - start;

    // Must resolve/reject well before the 5000ms exit delay
    expect(elapsed).toBeLessThan(2000);
  });
});

// ═══════════════════════════════════════════════════════════════
// Suite 3: Signal aborted mid-stream
// ═══════════════════════════════════════════════════════════════

describe("claudeStream — signal aborted mid-stream", () => {
  test("signal aborted mid-stream → proc.kill() is called", async () => {
    const killFn = mock(() => {});
    const cs = controllableStream();
    const encoder = new TextEncoder();
    cs.enqueue(encoder.encode(assistantLine("partial output") + "\n"));

    spawnMock.mockImplementation(() =>
      mockProc({
        stdout: cs,
        exitCode: 143,
        exitDelay: 5000,
        onKill: () => { killFn(); },
      })
    );

    const controller = new AbortController();
    const streamPromise = claudeStream("prompt", { signal: controller.signal });

    await new Promise<void>((r) => setTimeout(r, 50));
    controller.abort();

    await streamPromise.catch(() => {});

    expect(killFn).toHaveBeenCalledTimes(1);
  });

  test("signal aborted mid-stream → returns accumulated partial output", async () => {
    const partialText = "Here is the beginning of the answer";
    const cs = controllableStream();
    const encoder = new TextEncoder();
    cs.enqueue(encoder.encode(assistantLine(partialText) + "\n"));

    spawnMock.mockImplementation(() =>
      mockProc({ stdout: cs, exitCode: 143, exitDelay: 5000 })
    );

    const controller = new AbortController();
    const streamPromise = claudeStream("prompt", { signal: controller.signal });

    await new Promise<void>((r) => setTimeout(r, 50));
    controller.abort();

    const result = await streamPromise;
    expect(result).toBe(partialText);
  });

  test("signal aborted with no prior output → returns empty string (no throw)", async () => {
    const cs = controllableStream();
    // Don't enqueue anything — simulates silent hang

    spawnMock.mockImplementation(() =>
      mockProc({ stdout: cs, exitCode: 143, exitDelay: 5000 })
    );

    const controller = new AbortController();
    const streamPromise = claudeStream("prompt", { signal: controller.signal });

    await new Promise<void>((r) => setTimeout(r, 20));
    controller.abort();

    const result = await streamPromise;
    expect(typeof result).toBe("string");
  });
});

// ═══════════════════════════════════════════════════════════════
// Suite 4: Stream completes before signal fires
// ═══════════════════════════════════════════════════════════════

describe("claudeStream — stream completes before signal fires", () => {
  test("stream completes before abort → returns full output", async () => {
    const ndjson = [assistantLine("thinking"), resultLine("Full answer")].join("\n") + "\n";
    spawnMock.mockImplementation(() => mockProc({ stdout: ndjson, exitCode: 0 }));

    const controller = new AbortController();
    const result = await claudeStream("prompt", { signal: controller.signal });

    // Abort AFTER completion — must be no-op
    controller.abort();

    expect(result).toBe("Full answer");
  });

  test("abort after completion does not call kill on the completed proc", async () => {
    const ndjson = resultLine("done") + "\n";
    const killMock = mock(() => {});

    spawnMock.mockImplementation(() => {
      const proc = mockProc({ stdout: ndjson, exitCode: 0 });
      proc.kill = killMock;
      return proc;
    });

    const controller = new AbortController();
    await claudeStream("prompt", { signal: controller.signal });
    controller.abort();

    // Give time for any async abort handler to fire
    await new Promise<void>((r) => setTimeout(r, 20));

    // kill should not have been called (stream finished before abort)
    expect(killMock).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════
// Suite 5: Edge cases
// ═══════════════════════════════════════════════════════════════

describe("claudeStream — cancellation edge cases", () => {
  test("rapid abort on same tick as call → does not hang indefinitely", async () => {
    const cs = controllableStream();

    spawnMock.mockImplementation(() =>
      mockProc({ stdout: cs, exitCode: 143, exitDelay: 5000 })
    );

    const controller = new AbortController();
    const streamPromise = claudeStream("prompt", { signal: controller.signal });

    // Abort synchronously on next tick
    controller.abort();

    const raceResult = await Promise.race([
      streamPromise.then(() => "resolved").catch(() => "rejected"),
      new Promise<string>((r) => setTimeout(() => r("timeout"), 3000)),
    ]);

    expect(raceResult).not.toBe("timeout");
  });

  test("abort called twice → no double kill (idempotent)", async () => {
    const killMock = mock(() => {});
    const cs = controllableStream();

    spawnMock.mockImplementation(() =>
      mockProc({
        stdout: cs,
        exitCode: 143,
        exitDelay: 5000,
        onKill: () => { killMock(); },
      })
    );

    const controller = new AbortController();
    const streamPromise = claudeStream("prompt", { signal: controller.signal });

    await new Promise<void>((r) => setTimeout(r, 10));
    controller.abort(); // first abort
    controller.abort(); // second abort — AbortController is idempotent, { once: true } ensures single call

    await streamPromise.catch(() => {});

    expect(killMock).toHaveBeenCalledTimes(1);
  });
});
