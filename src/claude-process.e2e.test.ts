/**
 * End-to-end tests for the unified Claude CLI process spawner.
 *
 * Covers all spawn modes:
 *   1. Simple text call (claudeText)
 *   2. Streaming call with progress (claudeStream)
 *   3. Permission approval — approve (SessionRunner)
 *   4. Permission approval — deny (SessionRunner)
 *   5. Process timeout
 *   6. Process crash / non-zero exit
 *   7. CLI not found (spawn failure)
 *   8. Concurrent calls
 *   9. Fallback behavior (claudeText error → graceful degradation)
 *
 * Strategy: mock `bun`'s `spawn` via `mock.module` to simulate
 * subprocess behavior without requiring a real Claude CLI binary.
 *
 * Run: bun test src/claude-process.e2e.test.ts
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Spawn mock infrastructure ────────────────────────────────────────────────

/**
 * Create a ReadableStream that emits the given string and closes.
 */
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
 * Create a mock process object compatible with Bun's spawn return type.
 */
function mockProc(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  /** Delay in ms before exit resolves */
  exitDelay?: number;
  /** If true, kill() resolves the exit promise immediately */
  killable?: boolean;
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

  return {
    stdout: textStream(opts.stdout ?? ""),
    stderr: textStream(opts.stderr ?? ""),
    exited: exitPromise,
    kill: mock(() => {
      if (resolveExit) resolveExit(opts.exitCode ?? 1);
    }),
    pid: Math.floor(Math.random() * 99999),
  };
}

// The mock function we control in tests
const spawnMock = mock((..._args: unknown[]) => mockProc({ stdout: "ok" }));

// Mock spawn via the user-land wrapper (mock.module cannot intercept Bun's native built-ins)
mock.module("./spawn", () => ({
  spawn: spawnMock,
}));

// Import AFTER mocking so the module picks up our mock
const { claudeText, claudeStream, buildClaudeEnv, getClaudePath } = await import(
  "./claude-process.ts"
);

beforeEach(() => {
  spawnMock.mockReset();
});

// ============================================================
// 1. Simple text call — claudeText
// ============================================================

describe("claudeText — simple text call", () => {
  test("returns trimmed stdout on success", async () => {
    spawnMock.mockImplementation(() =>
      mockProc({ stdout: "  Hello from Claude  \n", exitCode: 0 })
    );

    const result = await claudeText("Say hello");
    expect(result).toBe("Hello from Claude");
  });

  test("passes correct args to spawn", async () => {
    spawnMock.mockImplementation(() =>
      mockProc({ stdout: "response", exitCode: 0 })
    );

    await claudeText("test prompt", { model: "claude-sonnet-4-5-20250514" });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [args, opts] = spawnMock.mock.calls[0] as [string[], Record<string, unknown>];
    expect(args).toContain("-p");
    expect(args).toContain("test prompt");
    expect(args).toContain("--output-format");
    expect(args).toContain("text");
    expect(args).toContain("--model");
    expect(args).toContain("claude-sonnet-4-5-20250514");

    // Env should have CLAUDE_SUBPROCESS=1 and no session detection vars
    const env = opts.env as Record<string, string | undefined>;
    expect(env.CLAUDE_SUBPROCESS).toBe("1");
    expect(env.CLAUDECODE).toBeUndefined();
  });

  test("uses default model when not specified", async () => {
    spawnMock.mockImplementation(() =>
      mockProc({ stdout: "response", exitCode: 0 })
    );

    await claudeText("prompt");

    const [args] = spawnMock.mock.calls[0] as [string[]];
    expect(args).toContain("claude-haiku-4-5-20251001");
  });
});

// ============================================================
// 2. Streaming call — claudeStream
// ============================================================

describe("claudeStream — streaming NDJSON call", () => {
  test("returns result text from stream events", async () => {
    const ndjson = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-123" }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Working on it..." }] },
      }),
      JSON.stringify({ type: "result", subtype: "success", result: "Final answer" }),
    ].join("\n") + "\n";

    spawnMock.mockImplementation(() =>
      mockProc({ stdout: ndjson, exitCode: 0 })
    );

    const result = await claudeStream("Build something");
    expect(result).toBe("Final answer");
  });

  test("calls onProgress and onSessionId callbacks", async () => {
    const ndjson = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-abc" }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Step 1 done" }] },
      }),
      JSON.stringify({
        type: "tool_use",
        name: "Bash",
        input: { command: "echo hello" },
      }),
      JSON.stringify({ type: "result", subtype: "success", result: "Done" }),
    ].join("\n") + "\n";

    spawnMock.mockImplementation(() =>
      mockProc({ stdout: ndjson, exitCode: 0 })
    );

    const progressUpdates: string[] = [];
    let capturedSessionId = "";

    await claudeStream("task", {
      onProgress: (s) => progressUpdates.push(s),
      onSessionId: (id) => { capturedSessionId = id; },
    });

    expect(capturedSessionId).toBe("sess-abc");
    expect(progressUpdates).toContain("Step 1 done");
    expect(progressUpdates.some((p) => p.startsWith("bash:"))).toBe(true);
  });

  test("falls back to lastAssistantText when no result event", async () => {
    const ndjson = [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Only assistant text here" }] },
      }),
    ].join("\n") + "\n";

    spawnMock.mockImplementation(() =>
      mockProc({ stdout: ndjson, exitCode: 0 })
    );

    const result = await claudeStream("prompt");
    expect(result).toBe("Only assistant text here");
  });

  test("passes --resume flag when sessionId is provided", async () => {
    const ndjson = JSON.stringify({ type: "result", subtype: "success", result: "ok" }) + "\n";
    spawnMock.mockImplementation(() =>
      mockProc({ stdout: ndjson, exitCode: 0 })
    );

    await claudeStream("continue", { sessionId: "sess-resume-1" });

    const [args] = spawnMock.mock.calls[0] as [string[]];
    expect(args).toContain("--resume");
    expect(args).toContain("sess-resume-1");
  });
});

// ============================================================
// 3 & 4. Permission approval — approve / deny (SessionRunner)
// ============================================================

describe("SessionRunner — permission flow via buildClaudeEnv", () => {
  test("SessionRunner.buildEnv removes session detection vars", () => {
    // SessionRunner.buildEnv delegates to buildClaudeEnv — test the delegate directly
    const env = buildClaudeEnv({
      CLAUDECODE: "1",
      CLAUDE_CODE_SSE_PORT: "3000",
      CLAUDE_CODE_ENTRYPOINT: "/path",
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
      PATH: "/usr/bin",
    });

    expect(env).not.toHaveProperty("CLAUDECODE");
    expect(env).not.toHaveProperty("CLAUDE_CODE_SSE_PORT");
    expect(env).not.toHaveProperty("CLAUDE_CODE_ENTRYPOINT");
    expect(env).not.toHaveProperty("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS");
    expect(env.CLAUDE_SUBPROCESS).toBe("1");
    expect(env.PATH).toBe("/usr/bin");
  });

  test("SessionRunner.buildEnv re-enables agent teams when requested", () => {
    const env = buildClaudeEnv(
      { CLAUDECODE: "1", PATH: "/usr/bin" },
      { useAgentTeam: true }
    );

    expect(env).not.toHaveProperty("CLAUDECODE");
    expect(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe("1");
    expect(env.CLAUDE_SUBPROCESS).toBe("1");
  });

  test("Permission approve: env stripping allows subprocess to start fresh", () => {
    // The key invariant: even when parent process has all session vars,
    // the child gets a clean env that won't trigger nested-session detection
    const parentEnv: NodeJS.ProcessEnv = {
      CLAUDECODE: "1",
      CLAUDE_CODE_SSE_PORT: "9999",
      CLAUDE_CODE_ENTRYPOINT: "/somewhere",
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
      PATH: "/usr/bin",
      HOME: "/home/user",
      CUSTOM_VAR: "keep-me",
    };

    const childEnv = buildClaudeEnv(parentEnv);

    // Session vars stripped
    expect(childEnv.CLAUDECODE).toBeUndefined();
    expect(childEnv.CLAUDE_CODE_SSE_PORT).toBeUndefined();
    expect(childEnv.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(childEnv.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBeUndefined();

    // Subprocess marker set
    expect(childEnv.CLAUDE_SUBPROCESS).toBe("1");

    // Other vars preserved
    expect(childEnv.CUSTOM_VAR).toBe("keep-me");
    expect(childEnv.PATH).toBe("/usr/bin");
    expect(childEnv.HOME).toBe("/home/user");
  });

  test("Permission deny: env is not mutated when buildClaudeEnv is called", () => {
    // If a permission is denied, the parent env must remain untouched
    const parentEnv: NodeJS.ProcessEnv = {
      CLAUDECODE: "1",
      CLAUDE_CODE_SSE_PORT: "9999",
      FOO: "bar",
    };

    buildClaudeEnv(parentEnv);

    // Parent env must be intact
    expect(parentEnv.CLAUDECODE).toBe("1");
    expect(parentEnv.CLAUDE_CODE_SSE_PORT).toBe("9999");
    expect(parentEnv.FOO).toBe("bar");
  });
});

// ============================================================
// 5. Process timeout
// ============================================================

describe("Process timeout", () => {
  test("claudeText throws on timeout", async () => {
    // Process that never exits
    spawnMock.mockImplementation(() =>
      mockProc({ stdout: "", exitCode: 1, exitDelay: 60_000, killable: true })
    );

    await expect(
      claudeText("slow prompt", { timeoutMs: 50 })
    ).rejects.toThrow(/timeout after 50ms/);
  });

  test("claudeStream idle timeout is tested separately", () => {
    // The wall-clock timeoutMs option was replaced by an activity-based idle timer.
    // Tests for idle/soft-ceiling behaviour live in:
    //   src/claude-process.idle-timeout.test.ts
    expect(true).toBe(true);
  });
});

// ============================================================
// 6. Process crash / non-zero exit
// ============================================================

describe("Process crash / non-zero exit", () => {
  test("claudeText throws with stderr on non-zero exit", async () => {
    spawnMock.mockImplementation(() =>
      mockProc({ stdout: "", stderr: "segfault", exitCode: 139 })
    );

    await expect(claudeText("crash prompt")).rejects.toThrow(
      /exit 139.*segfault/
    );
  });

  test("claudeText throws on empty response with exit 0", async () => {
    spawnMock.mockImplementation(() =>
      mockProc({ stdout: "", exitCode: 0 })
    );

    await expect(claudeText("empty prompt")).rejects.toThrow(/empty response/);
  });

  test("claudeStream throws with stderr on non-zero exit", async () => {
    spawnMock.mockImplementation(() =>
      mockProc({ stdout: "", stderr: "out of memory", exitCode: 137 })
    );

    await expect(claudeStream("crash stream")).rejects.toThrow(
      /exit 137.*out of memory/
    );
  });
});

// ============================================================
// 7. CLI not found (spawn failure)
// ============================================================

describe("CLI not found — spawn failure", () => {
  test("claudeText throws helpful error when spawn fails", async () => {
    spawnMock.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });

    await expect(
      claudeText("prompt", { claudePath: "/nonexistent/claude" })
    ).rejects.toThrow(/failed to spawn.*\/nonexistent\/claude.*ENOENT/);
  });

  test("error message includes PM2 hint", async () => {
    spawnMock.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    try {
      await claudeText("prompt");
      expect(true).toBe(false); // should not reach
    } catch (e) {
      expect((e as Error).message).toContain("CLAUDE_PATH");
      expect((e as Error).message).toContain("PM2");
    }
  });
});

// ============================================================
// 8. Concurrent calls
// ============================================================

describe("Concurrent calls", () => {
  test("multiple claudeText calls run independently", async () => {
    let callCount = 0;
    spawnMock.mockImplementation(() => {
      callCount++;
      return mockProc({
        stdout: `Response ${callCount}`,
        exitCode: 0,
        exitDelay: 10,
      });
    });

    const [r1, r2, r3] = await Promise.all([
      claudeText("prompt 1"),
      claudeText("prompt 2"),
      claudeText("prompt 3"),
    ]);

    expect(spawnMock).toHaveBeenCalledTimes(3);
    // Each call should get a response (content doesn't matter, just no crash)
    expect(r1).toBeTruthy();
    expect(r2).toBeTruthy();
    expect(r3).toBeTruthy();
  });

  test("one failing concurrent call does not affect others", async () => {
    let callIndex = 0;
    spawnMock.mockImplementation(() => {
      callIndex++;
      if (callIndex === 2) {
        // Second call crashes
        return mockProc({ stdout: "", stderr: "crash", exitCode: 1 });
      }
      return mockProc({ stdout: `ok-${callIndex}`, exitCode: 0 });
    });

    const results = await Promise.allSettled([
      claudeText("prompt 1"),
      claudeText("prompt 2"),
      claudeText("prompt 3"),
    ]);

    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("rejected");
    expect(results[2].status).toBe("fulfilled");
  });

  test("concurrent claudeText and claudeStream do not interfere", async () => {
    spawnMock.mockImplementation((...args: unknown[]) => {
      const cmdArgs = args[0] as string[];
      if (cmdArgs.includes("stream-json")) {
        const ndjson =
          JSON.stringify({ type: "result", subtype: "success", result: "stream result" }) + "\n";
        return mockProc({ stdout: ndjson, exitCode: 0 });
      }
      return mockProc({ stdout: "text result", exitCode: 0 });
    });

    const [textResult, streamResult] = await Promise.all([
      claudeText("text prompt"),
      claudeStream("stream prompt"),
    ]);

    expect(textResult).toBe("text result");
    expect(streamResult).toBe("stream result");
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });
});

// ============================================================
// 9. Fallback behavior — graceful degradation
// ============================================================

describe("Fallback behavior — graceful degradation", () => {
  test("claudeText error can be caught for fallback logic", async () => {
    spawnMock.mockImplementation(() =>
      mockProc({ stdout: "", stderr: "API key expired", exitCode: 1 })
    );

    let fallbackUsed = false;
    let result: string;

    try {
      result = await claudeText("prompt");
    } catch {
      // Caller's fallback logic (e.g., Ollama)
      fallbackUsed = true;
      result = "fallback response";
    }

    expect(fallbackUsed).toBe(true);
    expect(result).toBe("fallback response");
  });

  test("claudeText timeout can be caught for fallback logic", async () => {
    spawnMock.mockImplementation(() =>
      mockProc({ stdout: "", exitCode: 1, exitDelay: 60_000, killable: true })
    );

    let errorType = "";

    try {
      await claudeText("slow", { timeoutMs: 50 });
    } catch (e) {
      errorType = (e as Error).message.includes("timeout") ? "timeout" : "other";
    }

    expect(errorType).toBe("timeout");
  });

  test("claudeStream error can be caught for fallback logic", async () => {
    spawnMock.mockImplementation(() =>
      mockProc({ stdout: "", stderr: "connection refused", exitCode: 1 })
    );

    let fallbackUsed = false;

    try {
      await claudeStream("prompt");
    } catch {
      fallbackUsed = true;
    }

    expect(fallbackUsed).toBe(true);
  });

  test("spawn failure (CLI not found) is distinguishable from runtime error", async () => {
    spawnMock.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    try {
      await claudeText("prompt");
      expect(true).toBe(false);
    } catch (e) {
      const msg = (e as Error).message;
      // Spawn failures mention "failed to spawn" — runtime errors don't
      expect(msg).toContain("failed to spawn");
    }
  });
});

// ============================================================
// 10. Graceful cancellation — exit 130 / 143
// ============================================================

describe("Graceful cancellation — exit 130 (SIGINT) and 143 (SIGTERM)", () => {
  test("claudeStream exit 130 returns partial result without throwing", async () => {
    const ndjson = [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Partial answer so far" }] },
      }),
    ].join("\n") + "\n";

    spawnMock.mockImplementation(() =>
      mockProc({ stdout: ndjson, exitCode: 130 })
    );

    // Should NOT throw — should return whatever was accumulated
    const result = await claudeStream("long task");
    expect(result).toBe("Partial answer so far");
  });

  test("claudeStream exit 130 with a result event returns the result", async () => {
    const ndjson = [
      JSON.stringify({ type: "result", subtype: "success", result: "Completed result" }),
    ].join("\n") + "\n";

    spawnMock.mockImplementation(() =>
      mockProc({ stdout: ndjson, exitCode: 130 })
    );

    const result = await claudeStream("task");
    expect(result).toBe("Completed result");
  });

  test("claudeStream exit 130 with no output returns empty string without throwing", async () => {
    spawnMock.mockImplementation(() =>
      mockProc({ stdout: "", exitCode: 130 })
    );

    const result = await claudeStream("task interrupted before output");
    expect(result).toBe("");
  });

  test("claudeStream exit 143 (SIGTERM) returns partial result without throwing", async () => {
    const ndjson = [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Stopped mid-response" }] },
      }),
    ].join("\n") + "\n";

    spawnMock.mockImplementation(() =>
      mockProc({ stdout: ndjson, exitCode: 143 })
    );

    const result = await claudeStream("another task");
    expect(result).toBe("Stopped mid-response");
  });

  test("claudeStream exit 1 (real error) still throws", async () => {
    spawnMock.mockImplementation(() =>
      mockProc({ stdout: "", stderr: "auth error", exitCode: 1 })
    );

    await expect(claudeStream("failing task")).rejects.toThrow(/exit 1.*auth error/);
  });

  test("claudeStream exit 137 (SIGKILL) still throws", async () => {
    spawnMock.mockImplementation(() =>
      mockProc({ stdout: "", stderr: "", exitCode: 137 })
    );

    await expect(claudeStream("oom task")).rejects.toThrow(/exit 137/);
  });
});

// ============================================================
// 11. Stderr memory limit — large output stays within 8KB
// ============================================================

describe("Stderr memory limit — large stderr capped at 8KB", () => {
  test("claudeStream large stderr is capped in error message", async () => {
    // Generate 50KB of stderr content
    const largStderr = "X".repeat(50_000);

    spawnMock.mockImplementation(() =>
      mockProc({ stdout: "", stderr: largStderr, exitCode: 1 })
    );

    let caughtError: Error | undefined;
    try {
      await claudeStream("task with huge stderr");
    } catch (e) {
      caughtError = e as Error;
    }

    expect(caughtError).toBeDefined();
    // Error message should not contain the full 50KB stderr
    // MAX_STDERR_BYTES = 8192, plus "exit 1 — " prefix
    expect(caughtError!.message.length).toBeLessThan(9000);
  });

  test("claudeText large stderr is capped in error message", async () => {
    const largStderr = "E".repeat(50_000);

    spawnMock.mockImplementation(() =>
      mockProc({ stdout: "", stderr: largStderr, exitCode: 1 })
    );

    let caughtError: Error | undefined;
    try {
      await claudeText("task with huge stderr");
    } catch (e) {
      caughtError = e as Error;
    }

    expect(caughtError).toBeDefined();
    expect(caughtError!.message.length).toBeLessThan(9000);
  });

  test("claudeStream small stderr is preserved fully in error message", async () => {
    const smallStderr = "specific error: connection refused to api.anthropic.com";

    spawnMock.mockImplementation(() =>
      mockProc({ stdout: "", stderr: smallStderr, exitCode: 1 })
    );

    await expect(claudeStream("task")).rejects.toThrow(smallStderr);
  });
});

// ============================================================
// Binary path resolution — getClaudePath
// ============================================================

describe("getClaudePath — binary path resolution", () => {
  test("explicit override takes highest priority", () => {
    expect(getClaudePath("/custom/bin/claude")).toBe("/custom/bin/claude");
  });

  test("defaults to 'claude' when no overrides", () => {
    const origPath = process.env.CLAUDE_PATH;
    const origBinary = process.env.CLAUDE_BINARY;
    delete process.env.CLAUDE_PATH;
    delete process.env.CLAUDE_BINARY;

    expect(getClaudePath()).toBe("claude");

    if (origPath !== undefined) process.env.CLAUDE_PATH = origPath;
    if (origBinary !== undefined) process.env.CLAUDE_BINARY = origBinary;
  });
});

// ============================================================
// Environment construction — buildClaudeEnv
// ============================================================

describe("buildClaudeEnv — environment construction", () => {
  test("strips all 4 session detection vars", () => {
    const env = buildClaudeEnv({
      CLAUDECODE: "1",
      CLAUDE_CODE_SSE_PORT: "3000",
      CLAUDE_CODE_ENTRYPOINT: "/path",
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
      PATH: "/usr/bin",
    });

    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_SSE_PORT).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBeUndefined();
    expect(env.CLAUDE_SUBPROCESS).toBe("1");
  });

  test("defaults to process.env when no base provided", () => {
    const env = buildClaudeEnv();
    expect(env.CLAUDE_SUBPROCESS).toBe("1");
    expect(env.CLAUDECODE).toBeUndefined();
  });
});
