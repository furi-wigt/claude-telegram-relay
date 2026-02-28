/**
 * Unit tests for claudeStream activity-based idle timeout.
 *
 * Tests the NEW idle timer behaviour introduced in place of the wall-clock
 * CLAUDE_TIMEOUT. Key invariants:
 *   - Idle timer fires if no stdout chunk arrives for CLAUDE_IDLE_TIMEOUT_MS
 *   - Each raw stdout chunk resets the idle timer
 *   - Soft ceiling fires at CLAUDE_SOFT_CEILING_MS without killing the process
 *   - Both timers are cleared on natural completion or external abort
 *
 * Strategy: set env vars BEFORE import (same pattern as cancel-e2e.test.ts) so
 * the module-level constants pick up short durations, enabling fast real-timer tests.
 *
 * Run: bun test src/claude-process.idle-timeout.test.ts
 */

import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";

// ── Timer durations for tests (set BEFORE import) ─────────────────────────────
// IDLE  = 150ms  — fires if no chunk arrives for 150ms
// SOFT  = 100ms  — soft ceiling fires at 100ms total elapsed
// (soft fires before idle — lets us test soft ceiling without triggering idle)
process.env.CLAUDE_IDLE_TIMEOUT_MS = "150";
process.env.CLAUDE_SOFT_CEILING_MS = "100";

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
 * A controllable stream: enqueue data on demand, close when done.
 * Models a real subprocess pipe where data arrives asynchronously.
 */
function controllableStream(): {
  stream: ReadableStream<Uint8Array>;
  enqueue: (data: Uint8Array) => void;
  close: () => void;
} {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) { ctrl = c; },
  });
  return {
    stream,
    enqueue: (data) => { try { ctrl.enqueue(data); } catch { /* closed */ } },
    close: () => { try { ctrl.close(); } catch { /* already closed */ } },
  };
}

// ── Mock proc factory ─────────────────────────────────────────────────────────

function mockProc(opts: {
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
      resolveExit = (code) => {
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
      closeStdout?.();
      if (resolveExit) resolveExit(opts.exitCode ?? 143);
    }),
    pid: Math.floor(Math.random() * 99999),
  };
}

// ── NDJSON helpers ───────────────────────────────────────────────────────────

const encoder = new TextEncoder();

function resultLine(result: string): string {
  return JSON.stringify({ type: "result", subtype: "success", result }) + "\n";
}

function assistantLine(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  }) + "\n";
}

// ── Module mock ───────────────────────────────────────────────────────────────

const spawnMock = mock((..._args: unknown[]) =>
  mockProc({ stdout: resultLine("default"), exitCode: 0 })
);

mock.module("./spawn", () => ({ spawn: spawnMock }));

const { claudeStream } = await import("./claude-process.ts");

beforeEach(() => {
  spawnMock.mockReset();
});

// Restore module mocks after this file so subsequent test files see the real spawn.
afterAll(() => {
  mock.restore();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Wait for ms milliseconds. */
function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ═══════════════════════════════════════════════════════════════
// Suite 1: Idle timer — kills on stall
// ═══════════════════════════════════════════════════════════════

describe("claudeStream — idle timer kills on stall", () => {
  test("no chunks → idle timer fires and stream rejects", async () => {
    const cs = controllableStream();
    // Never enqueue data — simulates a completely hung process

    spawnMock.mockImplementation(() =>
      mockProc({ stdout: cs, exitCode: 143, exitDelay: 5000 })
    );

    const result = await claudeStream("prompt").catch((e: Error) => e);

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe("claudeStream: idle timeout after 5 min");
  });

  test("idle timer exact error message matches expected string", async () => {
    const cs = controllableStream();

    spawnMock.mockImplementation(() =>
      mockProc({ stdout: cs, exitCode: 143, exitDelay: 5000 })
    );

    let caughtMessage = "";
    try {
      await claudeStream("test");
    } catch (e) {
      caughtMessage = e instanceof Error ? e.message : String(e);
    }

    expect(caughtMessage).toBe("claudeStream: idle timeout after 5 min");
  });

  test("no chunks → proc.kill() is called when idle timer fires", async () => {
    const killMock = mock(() => {});
    const cs = controllableStream();

    spawnMock.mockImplementation(() => {
      const proc = mockProc({ stdout: cs, exitCode: 143, exitDelay: 5000 });
      proc.kill = killMock;
      // Override kill to also close stdout so parseStream terminates
      const origKill = proc.kill;
      proc.kill = mock(() => {
        cs.close();
        origKill();
      });
      return proc;
    });

    await claudeStream("prompt").catch(() => {});

    expect(killMock).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════
// Suite 2: Idle timer — chunks reset the timer
// ═══════════════════════════════════════════════════════════════

describe("claudeStream — chunks reset idle timer", () => {
  test("chunks arriving before idle threshold keep stream alive", async () => {
    // IDLE = 150ms. Send chunks every 60ms (well within 150ms threshold).
    // After 4 chunks (~240ms total), close with result → stream should succeed.
    const cs = controllableStream();
    let closed = false;

    spawnMock.mockImplementation(() =>
      mockProc({ stdout: cs, exitCode: 0, exitDelay: 500 })
    );

    // Schedule chunks at 60ms intervals, then close at ~300ms
    const intervals: ReturnType<typeof setTimeout>[] = [];
    let count = 0;
    const chunkInterval = setInterval(() => {
      count++;
      if (count <= 4) {
        cs.enqueue(encoder.encode(assistantLine(`chunk ${count}`)));
      } else {
        clearInterval(chunkInterval);
        // Close after sending the result
        cs.enqueue(encoder.encode(resultLine("success after chunks")));
        cs.close();
        closed = true;
      }
    }, 60);

    const result = await claudeStream("prompt");

    clearInterval(chunkInterval);
    if (!closed) cs.close();

    expect(result).toBe("success after chunks");
  });

  test("stream that sends one chunk then closes succeeds (no idle timeout)", async () => {
    // Immediate stream with data — no idle timeout possible
    const ndjson = resultLine("immediate result");
    spawnMock.mockImplementation(() =>
      mockProc({ stdout: ndjson, exitCode: 0 })
    );

    const result = await claudeStream("prompt");
    expect(result).toBe("immediate result");
  });
});

// ═══════════════════════════════════════════════════════════════
// Suite 3: Soft ceiling — fires without killing
// ═══════════════════════════════════════════════════════════════

describe("claudeStream — soft ceiling fires without killing", () => {
  test("onSoftCeiling is called at soft ceiling time", async () => {
    // SOFT = 100ms. Send chunks every 30ms (resetting idle timer) so idle never fires.
    // After soft ceiling fires (100ms), close the stream.
    const cs = controllableStream();
    const softCeilingMock = mock((_msg: string) => {});
    let streamClosed = false;

    // exitDelay: 300 — process exits 100ms after stream closes (200ms), so proc.exited
    // resolves quickly without waiting beyond the 5000ms bun test timeout.
    spawnMock.mockImplementation(() =>
      mockProc({ stdout: cs, exitCode: 0, exitDelay: 300 })
    );

    // Keep idle timer reset by sending chunks every 30ms
    let chunkCount = 0;
    const chunkInterval = setInterval(() => {
      chunkCount++;
      cs.enqueue(encoder.encode(assistantLine(`tick ${chunkCount}`)));
    }, 30);

    // Close the stream 200ms in (after soft ceiling at 100ms, before idle at 150ms-from-last-chunk)
    const closeTimer = setTimeout(() => {
      clearInterval(chunkInterval);
      cs.enqueue(encoder.encode(resultLine("done after ceiling")));
      cs.close();
      streamClosed = true;
    }, 200);

    const result = await claudeStream("prompt", { onSoftCeiling: softCeilingMock });

    clearInterval(chunkInterval);
    clearTimeout(closeTimer);
    if (!streamClosed) cs.close();

    // Soft ceiling should have fired
    expect(softCeilingMock).toHaveBeenCalledTimes(1);
    // Stream should have completed normally (no throw)
    expect(result).toBe("done after ceiling");
  });

  test("onSoftCeiling receives the expected message text", async () => {
    const cs = controllableStream();
    let capturedMessage = "";

    // exitDelay: 300 — process exits 100ms after stream closes (200ms).
    spawnMock.mockImplementation(() =>
      mockProc({ stdout: cs, exitCode: 0, exitDelay: 300 })
    );

    // Keep idle alive, close after soft ceiling
    const chunkInterval = setInterval(() => {
      cs.enqueue(encoder.encode(assistantLine("ping")));
    }, 30);

    setTimeout(() => {
      clearInterval(chunkInterval);
      cs.enqueue(encoder.encode(resultLine("ok")));
      cs.close();
    }, 200);

    await claudeStream("prompt", {
      onSoftCeiling: (msg) => { capturedMessage = msg; },
    });

    expect(capturedMessage).toContain("30 min");
    expect(capturedMessage).toContain("/cancel");
  });

  test("soft ceiling does NOT kill the stream", async () => {
    const killMock = mock(() => {});
    const cs = controllableStream();

    spawnMock.mockImplementation(() => {
      // exitDelay: 300 — process exits 100ms after stream closes (200ms).
      const proc = mockProc({ stdout: cs, exitCode: 0, exitDelay: 300 });
      proc.kill = killMock;
      return proc;
    });

    // Keep sending chunks to prevent idle timeout
    const chunkInterval = setInterval(() => {
      cs.enqueue(encoder.encode(assistantLine("alive")));
    }, 30);

    // Close normally after soft ceiling
    setTimeout(() => {
      clearInterval(chunkInterval);
      cs.enqueue(encoder.encode(resultLine("done")));
      cs.close();
    }, 200);

    await claudeStream("prompt", { onSoftCeiling: () => {} });

    // kill() must NOT have been called by the soft ceiling
    expect(killMock).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════
// Suite 4: Natural completion clears both timers
// ═══════════════════════════════════════════════════════════════

describe("claudeStream — natural completion clears timers", () => {
  test("fast stream completes before soft ceiling — onSoftCeiling not called", async () => {
    const ndjson = resultLine("instant");
    const softCeilingMock = mock((_msg: string) => {});

    spawnMock.mockImplementation(() =>
      mockProc({ stdout: ndjson, exitCode: 0 })
    );

    const result = await claudeStream("prompt", { onSoftCeiling: softCeilingMock });

    // Wait past soft ceiling threshold to ensure it was cleared
    await wait(150);

    expect(result).toBe("instant");
    expect(softCeilingMock).not.toHaveBeenCalled();
  });

  test("fast stream completes — no idle timeout error thrown", async () => {
    const ndjson = resultLine("quick response");

    spawnMock.mockImplementation(() =>
      mockProc({ stdout: ndjson, exitCode: 0 })
    );

    // Should resolve, not reject
    await expect(claudeStream("prompt")).resolves.toBe("quick response");
  });
});

// ═══════════════════════════════════════════════════════════════
// Suite 5: External abort clears timers
// ═══════════════════════════════════════════════════════════════

describe("claudeStream — external abort clears idle and soft timers", () => {
  test("external abort mid-stream does not cause idle-timeout error", async () => {
    const cs = controllableStream();

    spawnMock.mockImplementation(() =>
      mockProc({ stdout: cs, exitCode: 143, exitDelay: 5000 })
    );

    const controller = new AbortController();
    const streamPromise = claudeStream("prompt", { signal: controller.signal });

    // Abort before idle timer fires (< 150ms)
    await wait(20);
    cs.enqueue(encoder.encode(assistantLine("partial")));
    await wait(20);
    controller.abort();

    const result = await streamPromise;

    // Should return partial output, NOT throw idle-timeout error
    expect(typeof result).toBe("string");
  });

  test("external abort mid-stream returns partial output without idle-timeout error", async () => {
    const cs = controllableStream();
    const partialText = "partial response so far";

    spawnMock.mockImplementation(() =>
      mockProc({ stdout: cs, exitCode: 143, exitDelay: 5000 })
    );

    const controller = new AbortController();
    cs.enqueue(encoder.encode(assistantLine(partialText)));

    const streamPromise = claudeStream("prompt", { signal: controller.signal });

    await wait(20);
    controller.abort();

    const result = await streamPromise;
    expect(result).toBe(partialText);
  });
});

// ═══════════════════════════════════════════════════════════════
// Suite 6: Pre-abort check (existing behaviour preserved)
// ═══════════════════════════════════════════════════════════════

describe("claudeStream — pre-abort check (unchanged behaviour)", () => {
  test("pre-aborted signal throws AbortError before spawning", async () => {
    const controller = new AbortController();
    controller.abort();

    // spawnMock should never be called
    spawnMock.mockImplementation(() =>
      mockProc({ stdout: resultLine("unreachable"), exitCode: 0 })
    );

    let thrownError: unknown;
    try {
      await claudeStream("prompt", { signal: controller.signal });
    } catch (e) {
      thrownError = e;
    }

    expect(thrownError).toBeInstanceOf(DOMException);
    expect((thrownError as DOMException).name).toBe("AbortError");
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
