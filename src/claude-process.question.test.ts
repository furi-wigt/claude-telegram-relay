/**
 * Unit tests for claudeStream AskUserQuestion / interactive mode support.
 *
 * Tests the new `onQuestion` option added to ClaudeStreamOptions:
 *   - Without onQuestion: args unchanged (one-shot -p <prompt> mode)
 *   - With onQuestion: interactive mode (-p --input-format stream-json, stdin pipe)
 *   - AskUserQuestion detection in both assistant.content and top-level tool_use events
 *   - Idle timer suspended before onQuestion, reset after
 *   - Soft ceiling suspended before onQuestion, reset after
 *   - tool_result written to stdin after answer injected
 *   - No crash when onQuestion not set and AskUserQuestion fires
 *
 * Strategy: mock `./spawn` via mock.module (same pattern as cancel.test.ts)
 * Run: bun test src/claude-process.question.test.ts
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

/** A controllable stream that can be closed from outside. */
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

// ── Mock stdin ────────────────────────────────────────────────────────────────

function mockStdin() {
  const writes: string[] = [];
  const decoder = new TextDecoder();
  return {
    writes,
    writer: {
      write: (data: Uint8Array) => { writes.push(decoder.decode(data)); },
    },
  };
}

// ── Mock proc factory ─────────────────────────────────────────────────────────

function mockProc(opts: {
  stdout?: string | { stream: ReadableStream<Uint8Array>; close: () => void };
  stderr?: string;
  exitCode?: number;
  exitDelay?: number;
  stdin?: ReturnType<typeof mockStdin>["writer"];
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
    stdin: opts.stdin ?? null,
    kill: mock(() => {
      opts.onKill?.();
      closeStdout?.();
      if (resolveExit) resolveExit(opts.exitCode ?? 143);
    }),
    pid: Math.floor(Math.random() * 99999),
  };
}

// ── NDJSON helpers ─────────────────────────────────────────────────────────────

function resultLine(result: string): string {
  return JSON.stringify({ type: "result", subtype: "success", result });
}

function assistantLine(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  });
}

/** A control_request for AskUserQuestion (the real CLI mechanism) */
function controlRequestAskUserQuestion(
  requestId: string,
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect?: boolean;
  }>
): string {
  return JSON.stringify({
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "can_use_tool",
      tool_name: "AskUserQuestion",
      input: { questions },
    },
  });
}

/** An assistant event with AskUserQuestion tool_use (emitted alongside control_request) */
function assistantWithAskUserQuestion(
  toolId: string,
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect?: boolean;
  }>
): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: toolId,
          name: "AskUserQuestion",
          input: { questions },
        },
      ],
    },
  });
}

/** A top-level AskUserQuestion tool_use event (legacy, no longer triggers handler) */
function topLevelAskUserQuestion(
  toolId: string,
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
  }>
): string {
  return JSON.stringify({
    type: "tool_use",
    id: toolId,
    name: "AskUserQuestion",
    input: { questions },
  });
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
// Suite 1: Arg construction — one-shot vs interactive mode
// ═══════════════════════════════════════════════════════════════

describe("claudeStream — arg construction", () => {
  test("without onQuestion: prompt is passed as CLI arg after -p", async () => {
    spawnMock.mockImplementation(() =>
      mockProc({ stdout: resultLine("ok") + "\n", exitCode: 0 })
    );

    await claudeStream("hello world");

    const [args] = spawnMock.mock.calls[0] as [string[], unknown];
    const pIdx = args.indexOf("-p");
    expect(pIdx).toBeGreaterThan(-1);
    expect(args[pIdx + 1]).toBe("hello world");
    // No --input-format in one-shot mode
    expect(args).not.toContain("--input-format");
  });

  test("with onQuestion: -p is present but prompt is NOT appended after it", async () => {
    const stdin = mockStdin();
    spawnMock.mockImplementation(() =>
      mockProc({ stdout: resultLine("ok") + "\n", exitCode: 0, stdin: stdin.writer })
    );

    await claudeStream("my prompt", {
      onQuestion: async () => ({}),
    });

    const [args] = spawnMock.mock.calls[0] as [string[], unknown];
    const pIdx = args.indexOf("-p");
    expect(pIdx).toBeGreaterThan(-1);
    // The element after -p must be --input-format, not free-form prompt text
    expect(args[pIdx + 1]).toBe("--input-format");
  });

  test("with onQuestion: --input-format stream-json is present", async () => {
    const stdin = mockStdin();
    spawnMock.mockImplementation(() =>
      mockProc({ stdout: resultLine("ok") + "\n", exitCode: 0, stdin: stdin.writer })
    );

    await claudeStream("prompt", { onQuestion: async () => ({}) });

    const [args] = spawnMock.mock.calls[0] as [string[], unknown];
    const ifIdx = args.indexOf("--input-format");
    expect(ifIdx).toBeGreaterThan(-1);
    expect(args[ifIdx + 1]).toBe("stream-json");
  });

  test("with onQuestion: --output-format stream-json still present", async () => {
    const stdin = mockStdin();
    spawnMock.mockImplementation(() =>
      mockProc({ stdout: resultLine("ok") + "\n", exitCode: 0, stdin: stdin.writer })
    );

    await claudeStream("prompt", { onQuestion: async () => ({}) });

    const [args] = spawnMock.mock.calls[0] as [string[], unknown];
    const ofIdx = args.indexOf("--output-format");
    expect(ofIdx).toBeGreaterThan(-1);
    expect(args[ofIdx + 1]).toBe("stream-json");
  });

  test("with onQuestion: spawn receives stdin: 'pipe'", async () => {
    const stdin = mockStdin();
    spawnMock.mockImplementation(() =>
      mockProc({ stdout: resultLine("ok") + "\n", exitCode: 0, stdin: stdin.writer })
    );

    await claudeStream("prompt", { onQuestion: async () => ({}) });

    const [, spawnOpts] = spawnMock.mock.calls[0] as [unknown, { stdin?: string }];
    expect(spawnOpts.stdin).toBe("pipe");
  });

  test("without onQuestion: spawn does NOT receive stdin: 'pipe'", async () => {
    spawnMock.mockImplementation(() =>
      mockProc({ stdout: resultLine("ok") + "\n", exitCode: 0 })
    );

    await claudeStream("prompt");

    const [, spawnOpts] = spawnMock.mock.calls[0] as [unknown, { stdin?: string }];
    expect(spawnOpts.stdin).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// Suite 2: Initial prompt sent to stdin in interactive mode
// ═══════════════════════════════════════════════════════════════

describe("claudeStream — interactive mode initial prompt via stdin", () => {
  test("initial prompt written to stdin as NDJSON user message", async () => {
    const stdin = mockStdin();
    spawnMock.mockImplementation(() =>
      mockProc({ stdout: resultLine("ok") + "\n", exitCode: 0, stdin: stdin.writer })
    );

    await claudeStream("test prompt content", { onQuestion: async () => ({}) });

    // At least one write should contain the user message
    const allWrites = stdin.writes.join("");
    const parsed = allWrites
      .split("\n")
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);

    const userMsg = parsed.find((e: Record<string, unknown>) => e.type === "user");
    expect(userMsg).toBeDefined();
    expect((userMsg as Record<string, unknown>).message).toMatchObject({
      role: "user",
      content: "test prompt content",
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// Suite 3: AskUserQuestion via assistant content block and top-level tool_use (primary path)
// ═══════════════════════════════════════════════════════════════

describe("claudeStream — AskUserQuestion via assistant content block", () => {
  test("onQuestion called with parsed questions from assistant content tool_use", async () => {
    const cs = controllableStream();
    const encoder = new TextEncoder();
    const stdin = mockStdin();

    let capturedEvent: unknown = null;

    spawnMock.mockImplementation(() =>
      mockProc({ stdout: cs, exitCode: 0, exitDelay: 3000, stdin: stdin.writer })
    );

    const streamPromise = claudeStream("prompt", {
      onQuestion: async (event) => {
        capturedEvent = event;
        cs.enqueue(encoder.encode(resultLine("done") + "\n"));
        cs.close();
        return { "Which framework?": "React" };
      },
    });

    cs.enqueue(encoder.encode(
      assistantWithAskUserQuestion("tool-123", [
        {
          question: "Which framework?",
          header: "Framework",
          options: [
            { label: "React", description: "Popular UI library" },
            { label: "Vue", description: "Progressive framework" },
          ],
        },
      ]) + "\n"
    ));

    await streamPromise.catch(() => {});

    expect(capturedEvent).not.toBeNull();
    const ev = capturedEvent as { toolUseId: string; questions: unknown[] };
    expect(ev.toolUseId).toBe("tool-123");
    expect(ev.questions).toHaveLength(1);
    const q = (ev.questions as Array<{ question: string; header: string; options: unknown[] }>)[0];
    expect(q.question).toBe("Which framework?");
    expect(q.header).toBe("Framework");
    expect(q.options).toHaveLength(2);
    const opt = (q.options as Array<{ label: string; description: string }>)[0];
    expect(opt.label).toBe("React");
    expect(opt.description).toBe("Popular UI library");
  });

  test("onQuestion called from top-level tool_use event", async () => {
    const cs = controllableStream();
    const encoder = new TextEncoder();
    const stdin = mockStdin();

    let capturedId: string | undefined;

    spawnMock.mockImplementation(() =>
      mockProc({ stdout: cs, exitCode: 0, exitDelay: 3000, stdin: stdin.writer })
    );

    const streamPromise = claudeStream("prompt", {
      onQuestion: async (event) => {
        capturedId = event.toolUseId;
        cs.enqueue(encoder.encode(resultLine("done") + "\n"));
        cs.close();
        return { "Q?": "A" };
      },
    });

    cs.enqueue(encoder.encode(
      topLevelAskUserQuestion("top-abc", [
        { question: "Q?", header: "Q", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] },
      ]) + "\n"
    ));

    await streamPromise.catch(() => {});
    expect(capturedId).toBe("top-abc");
  });

  test("onQuestion called with multiple questions (up to 4)", async () => {
    const cs = controllableStream();
    const encoder = new TextEncoder();
    const stdin = mockStdin();

    let questionCount = 0;

    spawnMock.mockImplementation(() =>
      mockProc({ stdout: cs, exitCode: 0, exitDelay: 3000, stdin: stdin.writer })
    );

    const streamPromise = claudeStream("prompt", {
      onQuestion: async (event) => {
        questionCount = event.questions.length;
        cs.enqueue(encoder.encode(resultLine("done") + "\n"));
        cs.close();
        return {};
      },
    });

    cs.enqueue(encoder.encode(
      assistantWithAskUserQuestion("req-multi", [
        { question: "Q1", header: "H1", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] },
        { question: "Q2", header: "H2", options: [{ label: "C", description: "c" }, { label: "D", description: "d" }] },
        { question: "Q3", header: "H3", options: [{ label: "E", description: "e" }, { label: "F", description: "f" }] },
      ]) + "\n"
    ));

    await streamPromise.catch(() => {});
    expect(questionCount).toBe(3);
  });

  test("multiSelect flag propagated correctly", async () => {
    const cs = controllableStream();
    const encoder = new TextEncoder();
    const stdin = mockStdin();

    let capturedMultiSelect: boolean | undefined;

    spawnMock.mockImplementation(() =>
      mockProc({ stdout: cs, exitCode: 0, exitDelay: 3000, stdin: stdin.writer })
    );

    const streamPromise = claudeStream("prompt", {
      onQuestion: async (event) => {
        capturedMultiSelect = event.questions[0]?.multiSelect;
        cs.enqueue(encoder.encode(resultLine("done") + "\n"));
        cs.close();
        return {};
      },
    });

    cs.enqueue(encoder.encode(
      assistantWithAskUserQuestion("req-multi-select", [
        {
          question: "Pick all that apply",
          header: "Pick",
          options: [{ label: "A", description: "a" }, { label: "B", description: "b" }],
          multiSelect: true,
        },
      ]) + "\n"
    ));

    await streamPromise.catch(() => {});
    expect(capturedMultiSelect).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// Suite 4: control_request fallback path also triggers onQuestion
// ═══════════════════════════════════════════════════════════════

describe("claudeStream — AskUserQuestion via control_request (fallback path)", () => {
  test("onQuestion also called from control_request can_use_tool event", async () => {
    const cs = controllableStream();
    const encoder = new TextEncoder();
    const stdin = mockStdin();

    let capturedId: string | undefined;

    spawnMock.mockImplementation(() =>
      mockProc({ stdout: cs, exitCode: 0, exitDelay: 3000, stdin: stdin.writer })
    );

    const streamPromise = claudeStream("prompt", {
      onQuestion: async (event) => {
        capturedId = event.toolUseId;
        cs.enqueue(encoder.encode(resultLine("done") + "\n"));
        cs.close();
        return { "Which framework?": "React" };
      },
    });

    cs.enqueue(encoder.encode(
      controlRequestAskUserQuestion("req-ctrl", [
        {
          question: "Which framework?",
          header: "FW",
          options: [{ label: "React", description: "r" }, { label: "Vue", description: "v" }],
        },
      ]) + "\n"
    ));

    await streamPromise.catch(() => {});
    expect(capturedId).toBe("req-ctrl");
  });
});

// ═══════════════════════════════════════════════════════════════
// Suite 5: tool_result user-envelope written to stdin after answer
// ═══════════════════════════════════════════════════════════════

describe("claudeStream — tool_result injected after onQuestion resolves", () => {
  test("tool_result user envelope written with answers keyed by question text", async () => {
    // Primary mechanism: relay detects AskUserQuestion in assistant content, sends
    // tool_result user envelope via stdin. answers keyed by question text (not index).
    //
    // The onQuestion callback returns answers; handleAskUserQuestion then writes the
    // tool_result to stdin. We keep the stream alive long enough to capture the write
    // by only resolving the exit AFTER onQuestion returns.
    const cs = controllableStream();
    const encoder = new TextEncoder();
    const stdin = mockStdin();

    let resolveQuestion!: (answers: Record<string, string>) => void;
    const questionBarrier = new Promise<Record<string, string>>((res) => { resolveQuestion = res; });

    spawnMock.mockImplementation(() =>
      mockProc({ stdout: cs, exitCode: 0, exitDelay: 3000, stdin: stdin.writer })
    );

    const answers = { "Which framework?": "React" };

    const streamPromise = claudeStream("prompt", {
      onQuestion: async () => {
        // Return answers immediately — handleAskUserQuestion will write to stdin,
        // then we close the stream.
        resolveQuestion(answers);
        return answers;
      },
    });

    cs.enqueue(encoder.encode(
      assistantWithAskUserQuestion("tool-abc", [
        {
          question: "Which framework?",
          header: "FW",
          options: [{ label: "React", description: "r" }, { label: "Vue", description: "v" }],
        },
      ]) + "\n"
    ));

    // Wait until onQuestion resolves, then let handleAskUserQuestion finish its write
    // by yielding the microtask queue before closing the stream.
    await questionBarrier;
    await new Promise<void>((r) => setTimeout(r, 50));
    cs.enqueue(encoder.encode(resultLine("done") + "\n"));
    cs.close();

    await streamPromise.catch(() => {});

    const allWrites = stdin.writes.join("");
    const parsed = allWrites
      .split("\n")
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean) as Array<Record<string, unknown>>;

    // Must write a user envelope containing tool_result
    type UserEnvelope = { type: string; message: { role: string; content: Array<{ type: string; tool_use_id?: string; content?: { answers: Record<string, string> } }> } };
    const userEnvelopes = parsed.filter((e) => e.type === "user") as UserEnvelope[];
    const toolResultEnvelope = userEnvelopes.find((e) =>
      Array.isArray(e.message?.content) &&
      e.message.content.some((b) => b.type === "tool_result")
    );
    expect(toolResultEnvelope).toBeDefined();
    expect(toolResultEnvelope!.message.role).toBe("user");

    const toolResult = toolResultEnvelope!.message.content.find((b) => b.type === "tool_result");
    expect(toolResult).toBeDefined();
    expect(toolResult!.tool_use_id).toBe("tool-abc");

    // answers keyed by question text, not index
    expect(toolResult!.content?.answers).toEqual({ "Which framework?": "React" });
  });

  test("no bare top-level control_response written (tool_result is the response)", async () => {
    const cs = controllableStream();
    const encoder = new TextEncoder();
    const stdin = mockStdin();

    spawnMock.mockImplementation(() =>
      mockProc({ stdout: cs, exitCode: 0, exitDelay: 3000, stdin: stdin.writer })
    );

    const streamPromise = claudeStream("prompt", {
      onQuestion: async () => {
        cs.enqueue(encoder.encode(resultLine("done") + "\n"));
        cs.close();
        return { "Q?": "A" };
      },
    });

    cs.enqueue(encoder.encode(
      assistantWithAskUserQuestion("tool-t1", [
        { question: "Q?", header: "H", options: [{ label: "A", description: "a" }] },
      ]) + "\n"
    ));

    await streamPromise.catch(() => {});

    const allWrites = stdin.writes.join("");
    const lines = allWrites.split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const msg = JSON.parse(line) as { type: string };
        // Should be user envelope, not bare tool_result or control_response
        if (msg.type !== "user") {
          expect(msg.type).not.toBe("tool_result");
          expect(msg.type).not.toBe("control_response");
        }
      } catch { /* skip non-JSON */ }
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// Suite 6: No crash when onQuestion not set
// ═══════════════════════════════════════════════════════════════

describe("claudeStream — AskUserQuestion without onQuestion set", () => {
  test("no crash and stream returns result when AskUserQuestion fires without handler", async () => {
    const ndjson = [
      assistantWithAskUserQuestion("t1", [
        { question: "Q?", header: "Q", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] },
      ]),
      resultLine("final result"),
    ].join("\n") + "\n";

    spawnMock.mockImplementation(() =>
      mockProc({ stdout: ndjson, exitCode: 0 })
    );

    // Should not throw even though onQuestion is not provided
    const result = await claudeStream("prompt");
    expect(result).toBe("final result");
  });

  test("other tool_use events still fire onProgress when AskUserQuestion is ignored", async () => {
    const progressSummaries: string[] = [];
    const ndjson = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "t1", name: "AskUserQuestion", input: { questions: [] } },
            { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/tmp/foo.ts" } },
          ],
        },
      }),
      resultLine("done"),
    ].join("\n") + "\n";

    spawnMock.mockImplementation(() => mockProc({ stdout: ndjson, exitCode: 0 }));

    await claudeStream("prompt", {
      onProgress: (s) => { progressSummaries.push(s); },
    });

    // Read tool should still produce progress summary; AskUserQuestion is silently skipped
    expect(progressSummaries.some((s) => s.includes("Read"))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// Suite 7: Soft ceiling fires at fixed time (no crash / smoke test)
// ═══════════════════════════════════════════════════════════════

describe("claudeStream — soft ceiling fires at fixed time", () => {
  test("onSoftCeiling called at CLAUDE_SOFT_CEILING_MS regardless of stream activity", async () => {
    process.env.CLAUDE_SOFT_CEILING_MS = "50"; // Very short for testing

    const cs = controllableStream();
    const encoder = new TextEncoder();
    let ceilingFired = false;

    spawnMock.mockImplementation(() =>
      mockProc({ stdout: cs, exitCode: 0, exitDelay: 3000 })
    );

    const streamPromise = claudeStream("prompt", {
      onSoftCeiling: () => { ceilingFired = true; },
    });

    // Emit some events during the ceiling window
    for (let i = 0; i < 3; i++) {
      cs.enqueue(encoder.encode(assistantLine(`chunk ${i}`) + "\n"));
      await new Promise<void>((r) => setTimeout(r, 10));
    }

    // Wait past the ceiling threshold (50ms), then close
    await new Promise<void>((r) => setTimeout(r, 60));
    cs.close();
    await streamPromise.catch(() => {});

    delete process.env.CLAUDE_SOFT_CEILING_MS;

    // Ceiling should have fired after 50ms from stream start
    expect(ceilingFired).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// Suite 8: Backward compatibility
// ═══════════════════════════════════════════════════════════════

describe("claudeStream — backward compatibility (no onQuestion)", () => {
  test("existing one-shot call still returns result", async () => {
    spawnMock.mockImplementation(() =>
      mockProc({ stdout: resultLine("answer") + "\n", exitCode: 0 })
    );

    const result = await claudeStream("simple prompt");
    expect(result).toBe("answer");
  });

  test("args unchanged for callers that don't use onQuestion", async () => {
    spawnMock.mockImplementation(() =>
      mockProc({ stdout: resultLine("ok") + "\n", exitCode: 0 })
    );

    await claudeStream("my question", { model: "claude-haiku-4-5-20251001" });

    const [args] = spawnMock.mock.calls[0] as [string[], unknown];
    // Should have prompt directly after -p
    const pIdx = args.indexOf("-p");
    expect(args[pIdx + 1]).toBe("my question");
    // No input-format
    expect(args).not.toContain("--input-format");
  });
});

// ═══════════════════════════════════════════════════════════════
// Suite: One-shot mode — proc.exited hang fix (issue 260228_224400)
// ═══════════════════════════════════════════════════════════════

describe("claudeStream — one-shot mode proc.exited hang fix", () => {
  test("proc.kill() called after result event so exited resolves promptly", async () => {
    // Simulate Claude emitting result but process not exiting on its own.
    // exitDelay is set to a long value — without the fix proc.exited would hang
    // until the idle timer fires.  With the fix, kill() is called immediately after
    // the result event and resolveExit() fires synchronously.
    let killCalled = false;

    spawnMock.mockImplementation(() =>
      mockProc({
        stdout: resultLine("long response text") + "\n",
        exitCode: 143, // SIGTERM — what proc.kill() triggers
        exitDelay: 60_000, // Would time out without the fix
        onKill: () => { killCalled = true; },
      })
    );

    const result = await claudeStream("explain something complex");

    // Result returned correctly (exit 143 treated as graceful)
    expect(result).toBe("long response text");
    // proc.kill() was called after result received
    expect(killCalled).toBe(true);
  });

  test("result returned correctly even when process exits via kill", async () => {
    spawnMock.mockImplementation(() =>
      mockProc({
        stdout: resultLine("the actual answer") + "\n",
        exitCode: 143,
        exitDelay: 60_000,
      })
    );

    const result = await claudeStream("some prompt");
    expect(result).toBe("the actual answer");
  });

  test("one-shot returns result even when process would otherwise hang indefinitely", async () => {
    // Worst-case: process never self-exits (exitDelay=long).
    // The fix calls proc.kill() after result → exitCode=143 (SIGTERM) → graceful return.
    spawnMock.mockImplementation(() =>
      mockProc({
        stdout: resultLine("correct answer") + "\n",
        exitCode: 143,
        exitDelay: 300_000, // 5 min — the old idle-timeout delay without the fix
      })
    );

    const result = await claudeStream("complex prompt");
    expect(result).toBe("correct answer");
  });
});
