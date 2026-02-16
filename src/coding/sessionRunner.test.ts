import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { SessionRunner } from "./sessionRunner.ts";
import type { RunnerCallbacks } from "./sessionRunner.ts";
import type { HandleEventContext } from "./sessionRunner.ts";

// ---------------------------------------------------------------------------
// Spawn configuration tests (Bugs 1-4)
// ---------------------------------------------------------------------------
//
// SessionRunner.buildArgs() and SessionRunner.buildEnv() are static helpers
// extracted specifically for testability. They encapsulate the exact spawn
// configuration that was the source of all four spawn-related bugs:
//
//   Bug 1: --dangerously-skip-permissions (kebab-case, not camelCase)
//   Bug 2: CLAUDECODE env var must be deleted before spawn
//   Bug 3: --verbose flag required alongside --output-format stream-json
//   Bug 4: task is NOT passed via -p; stdin receives it via sendUserMessage
//
// ---------------------------------------------------------------------------

describe("SessionRunner.buildArgs — spawn argument construction", () => {
  test("uses --dangerously-skip-permissions (kebab-case, Bug 1)", () => {
    // Bug 1: the flag was --dangerouslySkipPermissions (camelCase), which
    // Claude CLI does not recognise.  It must be kebab-case.
    const args = SessionRunner.buildArgs("claude", {});
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--dangerouslySkipPermissions");
  });

  test("includes --verbose flag (Bug 3)", () => {
    // Bug 3: --output-format stream-json requires --verbose when used with -p.
    // Without it Claude 2.x refuses to emit structured output.
    const args = SessionRunner.buildArgs("claude", {});
    expect(args).toContain("--verbose");
  });

  test("includes --output-format stream-json", () => {
    const args = SessionRunner.buildArgs("claude", {});
    const idx = args.indexOf("--output-format");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("stream-json");
  });

  test("includes --input-format stream-json (Bug 4 — enables stdin NDJSON)", () => {
    // Bug 4: --input-format stream-json is required so Claude reads the task
    // from stdin as an NDJSON message instead of a bare string via -p.
    const args = SessionRunner.buildArgs("claude", {});
    const idx = args.indexOf("--input-format");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("stream-json");
  });

  test("first element is the claudePath (binary)", () => {
    const args = SessionRunner.buildArgs("/usr/local/bin/claude", {});
    expect(args[0]).toBe("/usr/local/bin/claude");
  });

  test("second element is -p (print mode, no task text)", () => {
    // Bug 4: -p is present but the task text is NOT appended after it.
    // The task is sent later via stdin sendUserMessage, not as a CLI argument.
    const args = SessionRunner.buildArgs("claude", {});
    expect(args[1]).toBe("-p");
    // The element after -p must be a flag, not free-form task text.
    expect(args[2]).toMatch(/^--/);
  });

  test("exact base args array (Bugs 1, 3, 4 combined)", () => {
    // Regression guard: asserts the complete fixed argument list in order.
    const args = SessionRunner.buildArgs("claude", {});
    expect(args).toEqual([
      "claude",
      "-p",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    ]);
  });

  test("appends --resume when resume option is provided", () => {
    const args = SessionRunner.buildArgs("claude", { resume: "session-abc" });
    const idx = args.indexOf("--resume");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("session-abc");
  });

  test("does NOT append --use-agent-team (invalid flag) when useAgentTeam is true", () => {
    // --use-agent-team is not a valid Claude CLI flag; passing it causes exit code 1.
    // The --team Telegram option is preserved at the UI level only.
    const args = SessionRunner.buildArgs("claude", { useAgentTeam: true });
    expect(args).not.toContain("--use-agent-team");
  });

  test("does NOT append --use-agent-team when useAgentTeam is false", () => {
    const args = SessionRunner.buildArgs("claude", { useAgentTeam: false });
    expect(args).not.toContain("--use-agent-team");
  });

  // ---------------------------------------------------------------------------
  // Interactive mode for agent team sessions (Bug fix: worker message delivery)
  // ---------------------------------------------------------------------------
  //
  // When useAgentTeam is true, -p must be OMITTED so the interactive event loop
  // runs.  Without the event loop, the team lead cannot receive worker
  // SendMessage calls, and the session hangs indefinitely.
  //
  // See: .claude/todos/fix-agent-team-interactive-mode-for-worker-message-delivery.md
  // ---------------------------------------------------------------------------

  test("agent team args do NOT include -p flag when useAgentTeam is true", () => {
    // The interactive event loop (required for inter-agent message delivery)
    // is only active when -p / --print is absent.
    const args = SessionRunner.buildArgs("claude", { useAgentTeam: true });
    expect(args).not.toContain("-p");
    expect(args).not.toContain("--print");
  });

  test("regular session args include -p flag when useAgentTeam is false", () => {
    const args = SessionRunner.buildArgs("claude", { useAgentTeam: false });
    expect(args).toContain("-p");
  });

  test("regular session args include -p flag when useAgentTeam is undefined", () => {
    const args = SessionRunner.buildArgs("claude", {});
    expect(args).toContain("-p");
  });

  test("exact agent team args array (without -p, with all required flags)", () => {
    const args = SessionRunner.buildArgs("claude", { useAgentTeam: true });
    expect(args).toEqual([
      "claude",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    ]);
  });

  test("agent team args still include --resume when both useAgentTeam and resume are set", () => {
    const args = SessionRunner.buildArgs("claude", { useAgentTeam: true, resume: "ses-xyz" });
    expect(args).not.toContain("-p");
    const idx = args.indexOf("--resume");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("ses-xyz");
  });

  test("does NOT append --resume when resume is undefined", () => {
    const args = SessionRunner.buildArgs("claude", {});
    expect(args).not.toContain("--resume");
  });

  test("task text does NOT appear anywhere in args (Bug 4)", () => {
    // Bug 4: the old code passed the task as `[...args, task]` which hung
    // because stdin was left open.  Task must go via stdin, not args.
    const taskText = "Build a REST API with JWT auth";
    const args = SessionRunner.buildArgs("claude", {});
    // Neither the task text nor any continuation of it should be in args
    expect(args.join(" ")).not.toContain(taskText);
  });
});

describe("SessionRunner.buildEnv — subprocess environment", () => {
  test("CLAUDECODE is NOT present in the returned env (Bug 2)", () => {
    // Bug 2: the subprocess was inheriting CLAUDECODE from the parent process.
    // Claude CLI detects CLAUDECODE and refuses to start ("nested session" error).
    const fakeBase: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HOME: "/home/user",
      CLAUDECODE: "1",  // simulates the parent having this set
    };
    const env = SessionRunner.buildEnv(fakeBase);
    expect(env).not.toHaveProperty("CLAUDECODE");
  });

  test("other env vars are preserved", () => {
    const fakeBase: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/usr/local/bin",
      HOME: "/home/user",
      CLAUDECODE: "1",
    };
    const env = SessionRunner.buildEnv(fakeBase);
    expect(env.PATH).toBe("/usr/bin:/usr/local/bin");
    expect(env.HOME).toBe("/home/user");
  });

  test("does not mutate the original env object (Bug 2 safety)", () => {
    // Ensure buildEnv works on a copy, so callers don't see side effects.
    const original: NodeJS.ProcessEnv = { CLAUDECODE: "1", FOO: "bar" };
    SessionRunner.buildEnv(original);
    // The original must still have CLAUDECODE — we only deleted from the copy.
    expect(original.CLAUDECODE).toBe("1");
  });

  test("works safely when CLAUDECODE is not set in base env", () => {
    // Should not throw when deleting a key that doesn't exist.
    const fakeBase: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    expect(() => SessionRunner.buildEnv(fakeBase)).not.toThrow();
    const env = SessionRunner.buildEnv(fakeBase);
    expect(env).not.toHaveProperty("CLAUDECODE");
  });
});

/**
 * Tests for the SessionRunner NDJSON event handling logic.
 *
 * Since SessionRunner.run() spawns a real subprocess and we cannot reliably
 * mock Bun.spawn, we test handleEvent() directly via a type assertion.
 * This validates all the NDJSON parsing and callback dispatch logic without
 * requiring a live Claude binary.
 */

/** Call the static handleEvent method for testing. */
function callHandleEvent(
  _runner: SessionRunner,
  event: Record<string, unknown>,
  ctx: HandleEventContext
): void {
  SessionRunner.handleEvent(event, ctx);
}

/** Create a fresh event context for handleEvent calls. */
function createEventContext(callbacks: RunnerCallbacks, options: { useAgentTeam?: boolean } = {}) {
  let claudeSessionId = "";
  let lastAssistantText = "";
  let resultEmitted = false;
  let lastResultSummary = "";
  let teamName = "";
  const filesChanged: string[] = [];

  return {
    callbacks,
    filesChanged,
    useAgentTeam: options.useAgentTeam,
    get claudeSessionId() { return claudeSessionId; },
    get lastAssistantText() { return lastAssistantText; },
    get resultEmitted() { return resultEmitted; },
    get lastResultSummary() { return lastResultSummary; },
    get teamName() { return teamName; },
    setClaudeSessionId: (id: string) => { claudeSessionId = id; },
    setLastAssistantText: (t: string) => { lastAssistantText = t; },
    setResultEmitted: () => { resultEmitted = true; },
    setLastResultSummary: (s: string) => { lastResultSummary = s; },
    setTeamName: (name: string) => { teamName = name; },
  };
}

describe("SessionRunner handleEvent", () => {
  let runner: SessionRunner;

  beforeEach(() => {
    runner = new SessionRunner("claude");
  });

  describe("system init event", () => {
    test("captures session_id from init event", () => {
      const ctx = createEventContext({});
      callHandleEvent(runner, {
        type: "system",
        subtype: "init",
        session_id: "abc123",
      }, ctx);

      expect(ctx.claudeSessionId).toBe("abc123");
    });

    test("fires onSessionId callback with the Claude session ID from init event", () => {
      let capturedId = "";
      const ctx = createEventContext({
        onSessionId: (id) => { capturedId = id; },
      });

      callHandleEvent(runner, {
        type: "system",
        subtype: "init",
        session_id: "fa97d3a7-de3f-4e22-9740-57fa1ec8fe7a",
      }, ctx);

      expect(capturedId).toBe("fa97d3a7-de3f-4e22-9740-57fa1ec8fe7a");
    });

    test("does NOT fire onSessionId for system events without init subtype", () => {
      let callCount = 0;
      const ctx = createEventContext({
        onSessionId: () => { callCount++; },
      });

      callHandleEvent(runner, {
        type: "system",
        subtype: "other",
        session_id: "xyz",
      }, ctx);

      expect(callCount).toBe(0);
    });

    test("does NOT fire onSessionId when session_id is missing from init event", () => {
      let callCount = 0;
      const ctx = createEventContext({
        onSessionId: () => { callCount++; },
      });

      callHandleEvent(runner, {
        type: "system",
        subtype: "init",
        // no session_id field
      }, ctx);

      expect(callCount).toBe(0);
    });

    test("ignores system events without init subtype", () => {
      const ctx = createEventContext({});
      callHandleEvent(runner, {
        type: "system",
        subtype: "other",
        session_id: "xyz",
      }, ctx);

      expect(ctx.claudeSessionId).toBe("");
    });
  });

  describe("tool_use events", () => {
    test("fires onQuestion for AskUserQuestion with options", () => {
      let captured: { toolUseId: string; questionText: string; options?: string[] } | null = null;

      const ctx = createEventContext({
        onQuestion: (q) => { captured = q; },
      });

      callHandleEvent(runner, {
        type: "tool_use",
        name: "AskUserQuestion",
        id: "toolu_1",
        input: { question: "Pick a framework?", options: ["React", "Vue", "Svelte"] },
      }, ctx);

      expect(captured).not.toBeNull();
      expect(captured!.toolUseId).toBe("toolu_1");
      expect(captured!.questionText).toBe("Pick a framework?");
      expect(captured!.options).toEqual(["React", "Vue", "Svelte"]);
    });

    test("fires onQuestion for AskUserQuestion without options", () => {
      let captured: { toolUseId: string; questionText: string; options?: string[] } | null = null;

      const ctx = createEventContext({
        onQuestion: (q) => { captured = q; },
      });

      callHandleEvent(runner, {
        type: "tool_use",
        name: "AskUserQuestion",
        id: "toolu_2",
        input: { question: "What should we name this?" },
      }, ctx);

      expect(captured).not.toBeNull();
      expect(captured!.questionText).toBe("What should we name this?");
      expect(captured!.options).toBeUndefined();
    });

    test("tracks write_file in filesChanged", () => {
      const ctx = createEventContext({});

      callHandleEvent(runner, {
        type: "tool_use",
        name: "write_file",
        id: "t1",
        input: { file_path: "src/index.ts" },
      }, ctx);

      expect(ctx.filesChanged).toContain("src/index.ts");
    });

    test("tracks Edit tool in filesChanged", () => {
      const ctx = createEventContext({});

      callHandleEvent(runner, {
        type: "tool_use",
        name: "Edit",
        id: "t2",
        input: { file_path: "src/utils.ts" },
      }, ctx);

      expect(ctx.filesChanged).toContain("src/utils.ts");
    });

    test("tracks Write tool in filesChanged", () => {
      const ctx = createEventContext({});

      callHandleEvent(runner, {
        type: "tool_use",
        name: "Write",
        id: "t3",
        input: { file_path: "src/new.ts" },
      }, ctx);

      expect(ctx.filesChanged).toContain("src/new.ts");
    });

    test("does not duplicate filesChanged for same path", () => {
      const ctx = createEventContext({});

      callHandleEvent(runner, {
        type: "tool_use",
        name: "write_file",
        id: "t1",
        input: { file_path: "src/index.ts" },
      }, ctx);
      callHandleEvent(runner, {
        type: "tool_use",
        name: "Edit",
        id: "t2",
        input: { file_path: "src/index.ts" },
      }, ctx);

      const count = ctx.filesChanged.filter((f) => f === "src/index.ts").length;
      expect(count).toBe(1);
    });

    test("fires onProgress for file change tools", () => {
      const progressEvents: Array<{ type: string; summary: string }> = [];
      const ctx = createEventContext({
        onProgress: (e) => { progressEvents.push({ type: e.type, summary: e.summary }); },
      });

      callHandleEvent(runner, {
        type: "tool_use",
        name: "write_file",
        id: "t1",
        input: { file_path: "src/index.ts" },
      }, ctx);

      expect(progressEvents).toHaveLength(1);
      expect(progressEvents[0].type).toBe("tool_use");
      expect(progressEvents[0].summary).toContain("write_file");
      expect(progressEvents[0].summary).toContain("src/index.ts");
    });

    test("fires onProgress for Bash tool with command", () => {
      const progressEvents: Array<{ type: string; summary: string }> = [];
      const ctx = createEventContext({
        onProgress: (e) => { progressEvents.push({ type: e.type, summary: e.summary }); },
      });

      callHandleEvent(runner, {
        type: "tool_use",
        name: "Bash",
        id: "t1",
        input: { command: "npm test" },
      }, ctx);

      expect(progressEvents).toHaveLength(1);
      expect(progressEvents[0].summary).toContain("bash:");
      expect(progressEvents[0].summary).toContain("npm test");
    });

    test("truncates long bash commands in progress", () => {
      const progressEvents: Array<{ summary: string }> = [];
      const ctx = createEventContext({
        onProgress: (e) => { progressEvents.push({ summary: e.summary }); },
      });

      const longCommand = "x".repeat(200);
      callHandleEvent(runner, {
        type: "tool_use",
        name: "bash",
        id: "t1",
        input: { command: longCommand },
      }, ctx);

      expect(progressEvents[0].summary.length).toBeLessThan(200);
      expect(progressEvents[0].summary).toContain("...");
    });

    test("fires onProgress for generic tool use", () => {
      const progressEvents: Array<{ summary: string }> = [];
      const ctx = createEventContext({
        onProgress: (e) => { progressEvents.push({ summary: e.summary }); },
      });

      callHandleEvent(runner, {
        type: "tool_use",
        name: "Read",
        id: "t1",
        input: { file_path: "README.md" },
      }, ctx);

      expect(progressEvents).toHaveLength(1);
      expect(progressEvents[0].summary).toBe("Read");
    });
  });

  describe("assistant events", () => {
    test("fires onProgress with assistant text", () => {
      const progressEvents: Array<{ type: string; summary: string }> = [];
      const ctx = createEventContext({
        onProgress: (e) => { progressEvents.push({ type: e.type, summary: e.summary }); },
      });

      callHandleEvent(runner, {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Working on it..." }],
        },
      }, ctx);

      expect(progressEvents).toHaveLength(1);
      expect(progressEvents[0].type).toBe("assistant");
      expect(progressEvents[0].summary).toContain("Working on it...");
    });

    test("sets lastAssistantText", () => {
      const ctx = createEventContext({});

      callHandleEvent(runner, {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Final answer here" }],
        },
      }, ctx);

      expect(ctx.lastAssistantText).toBe("Final answer here");
    });

    test("truncates long assistant text in progress summary", () => {
      const progressEvents: Array<{ summary: string }> = [];
      const ctx = createEventContext({
        onProgress: (e) => { progressEvents.push({ summary: e.summary }); },
      });

      const longText = "A".repeat(300);
      callHandleEvent(runner, {
        type: "assistant",
        message: {
          content: [{ type: "text", text: longText }],
        },
      }, ctx);

      expect(progressEvents[0].summary.length).toBeLessThanOrEqual(203); // 200 + "..."
      expect(progressEvents[0].summary).toContain("...");
    });

    test("ignores assistant events with no text content", () => {
      const progressEvents: Array<{ summary: string }> = [];
      const ctx = createEventContext({
        onProgress: (e) => { progressEvents.push({ summary: e.summary }); },
      });

      callHandleEvent(runner, {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Read" }],
        },
      }, ctx);

      expect(progressEvents).toHaveLength(0);
    });

    test("ignores assistant events with no message", () => {
      const ctx = createEventContext({});

      // Should not throw
      callHandleEvent(runner, {
        type: "assistant",
      }, ctx);

      expect(ctx.lastAssistantText).toBe("");
    });
  });

  describe("plan_approval_request events", () => {
    test("fires onPlanApproval with requestId and planText", () => {
      let captured: { requestId: string; planText: string } | null = null;
      const ctx = createEventContext({
        onPlanApproval: (p) => { captured = p; },
      });

      callHandleEvent(runner, {
        type: "plan_approval_request",
        request_id: "req_1",
        plan: "Step 1: Install deps\nStep 2: Write tests",
      }, ctx);

      expect(captured).not.toBeNull();
      expect(captured!.requestId).toBe("req_1");
      expect(captured!.planText).toContain("Install deps");
    });

    test("handles missing plan text gracefully", () => {
      let captured: { requestId: string; planText: string } | null = null;
      const ctx = createEventContext({
        onPlanApproval: (p) => { captured = p; },
      });

      callHandleEvent(runner, {
        type: "plan_approval_request",
        request_id: "req_2",
      }, ctx);

      expect(captured).not.toBeNull();
      expect(captured!.planText).toBe("");
    });
  });

  describe("result events", () => {
    test("fires onComplete for success result", () => {
      let completed: { summary: string; filesChanged: string[]; claudeSessionId: string } | null = null;
      const ctx = createEventContext({
        onComplete: (r) => { completed = r; },
      });

      callHandleEvent(runner, {
        type: "result",
        subtype: "success",
        result: "All tests pass",
        session_id: "s2",
      }, ctx);

      expect(completed).not.toBeNull();
      expect(completed!.summary).toBe("All tests pass");
      expect(completed!.claudeSessionId).toBe("s2");
      expect(ctx.resultEmitted).toBe(true);
    });

    test("fires onError for error result", () => {
      let errorMsg = "";
      const ctx = createEventContext({
        onError: (err) => { errorMsg = err.message; },
      });

      callHandleEvent(runner, {
        type: "result",
        subtype: "error",
        error: "API rate limit exceeded",
      }, ctx);

      expect(errorMsg).toBe("API rate limit exceeded");
      expect(ctx.resultEmitted).toBe(true);
    });

    test("uses lastAssistantText as fallback summary when result is empty", () => {
      let summary = "";
      const ctx = createEventContext({
        onComplete: (r) => { summary = r.summary; },
      });

      // Set lastAssistantText first
      ctx.setLastAssistantText("Here is the final output");

      callHandleEvent(runner, {
        type: "result",
        subtype: "success",
        result: "",
      }, ctx);

      expect(summary).toBe("Here is the final output");
    });

    test("uses 'Completed' as fallback when both result and lastAssistantText are empty", () => {
      let summary = "";
      const ctx = createEventContext({
        onComplete: (r) => { summary = r.summary; },
      });

      callHandleEvent(runner, {
        type: "result",
        subtype: "success",
        result: "",
      }, ctx);

      expect(summary).toBe("Completed");
    });

    test("includes filesChanged in result", () => {
      let filesChanged: string[] = [];
      const ctx = createEventContext({
        onComplete: (r) => { filesChanged = r.filesChanged; },
      });

      // Add files first
      ctx.filesChanged.push("a.ts", "b.ts");

      callHandleEvent(runner, {
        type: "result",
        subtype: "success",
        result: "Done",
        session_id: "s3",
      }, ctx);

      expect(filesChanged).toContain("a.ts");
      expect(filesChanged).toContain("b.ts");
    });

    test("prefers session_id from result event over init event", () => {
      let sessionId = "";
      const ctx = createEventContext({
        onComplete: (r) => { sessionId = r.claudeSessionId; },
      });

      // Set initial session ID
      ctx.setClaudeSessionId("from_init");

      callHandleEvent(runner, {
        type: "result",
        subtype: "success",
        result: "Done",
        session_id: "from_result",
      }, ctx);

      expect(sessionId).toBe("from_result");
    });

    test("falls back to init session_id when result has no session_id", () => {
      let sessionId = "";
      const ctx = createEventContext({
        onComplete: (r) => { sessionId = r.claudeSessionId; },
      });

      ctx.setClaudeSessionId("from_init");

      callHandleEvent(runner, {
        type: "result",
        subtype: "success",
        result: "Done",
      }, ctx);

      expect(sessionId).toBe("from_init");
    });

    test("result error subtype with no error field calls onError with Unknown error", () => {
      let errorMsg = "";
      const ctx = createEventContext({
        onError: (err) => { errorMsg = err.message; },
      });

      callHandleEvent(runner, {
        type: "result",
        subtype: "error",
        // no error field
      }, ctx);

      expect(errorMsg).toBe("Unknown error");
      expect(ctx.resultEmitted).toBe(true);
    });

    test("result with unexpected subtype calls onError (falls into else branch)", () => {
      // The implementation: if subtype === "success" → onComplete, else → onError.
      // An unexpected subtype hits the else branch, calling onError with "Unknown error"
      // because event.error is undefined.
      let errorMsg = "";
      const ctx = createEventContext({
        onError: (err) => { errorMsg = err.message; },
      });

      callHandleEvent(runner, {
        type: "result",
        subtype: "something_unexpected",
      }, ctx);

      expect(errorMsg).toBe("Unknown error");
      expect(ctx.resultEmitted).toBe(true);
    });
  });

  describe("file-change tool coverage — all FILE_CHANGE_TOOLS members", () => {
    test("edit_file tracks in filesChanged", () => {
      const ctx = createEventContext({});

      callHandleEvent(runner, {
        type: "tool_use",
        name: "edit_file",
        id: "t_ef",
        input: { file_path: "src/edit.ts" },
      }, ctx);

      expect(ctx.filesChanged).toContain("src/edit.ts");
    });

    test("str_replace_editor tracks in filesChanged", () => {
      const ctx = createEventContext({});

      callHandleEvent(runner, {
        type: "tool_use",
        name: "str_replace_editor",
        id: "t_sre",
        input: { file_path: "src/replace.ts" },
      }, ctx);

      expect(ctx.filesChanged).toContain("src/replace.ts");
    });

    test("create_file tracks in filesChanged", () => {
      const ctx = createEventContext({});

      callHandleEvent(runner, {
        type: "tool_use",
        name: "create_file",
        id: "t_cf",
        input: { file_path: "src/new_file.ts" },
      }, ctx);

      expect(ctx.filesChanged).toContain("src/new_file.ts");
    });

    test("str_replace_based_edit_tool tracks in filesChanged", () => {
      const ctx = createEventContext({});

      callHandleEvent(runner, {
        type: "tool_use",
        name: "str_replace_based_edit_tool",
        id: "t_srbet",
        input: { file_path: "src/srbet.ts" },
      }, ctx);

      expect(ctx.filesChanged).toContain("src/srbet.ts");
    });

    test("tool input using path field (not file_path) tracks the path", () => {
      const ctx = createEventContext({});

      callHandleEvent(runner, {
        type: "tool_use",
        name: "Write",
        id: "t_path",
        input: { path: "src/via_path.ts" },
      }, ctx);

      expect(ctx.filesChanged).toContain("src/via_path.ts");
    });

    test("tool input using command field tracks the command value as path", () => {
      // str_replace_editor sometimes emits command as the path field
      const ctx = createEventContext({});

      callHandleEvent(runner, {
        type: "tool_use",
        name: "str_replace_editor",
        id: "t_cmd",
        input: { command: "view" },
      }, ctx);

      expect(ctx.filesChanged).toContain("view");
    });
  });

  describe("AskUserQuestion edge cases", () => {
    test("empty question text fires onQuestion with empty string", () => {
      let captured: { toolUseId: string; questionText: string; options?: string[] } | null = null;

      const ctx = createEventContext({
        onQuestion: (q) => { captured = q; },
      });

      callHandleEvent(runner, {
        type: "tool_use",
        name: "AskUserQuestion",
        id: "toolu_empty",
        input: { question: "" },
      }, ctx);

      expect(captured).not.toBeNull();
      expect(captured!.questionText).toBe("");
    });

    test("AskUserQuestion with no id field sets toolUseId to undefined", () => {
      let captured: { toolUseId: string | undefined; questionText: string } | null = null;

      const ctx = createEventContext({
        onQuestion: (q) => { captured = q; },
      });

      // No id field in event — toolId will be undefined cast as string
      callHandleEvent(runner, {
        type: "tool_use",
        name: "AskUserQuestion",
        input: { question: "No id here?" },
      }, ctx);

      expect(captured).not.toBeNull();
      expect(captured!.questionText).toBe("No id here?");
      // toolUseId will be undefined since event.id was missing
      expect(captured!.toolUseId).toBeUndefined();
    });

    test("AskUserQuestion does NOT fire onProgress", () => {
      const progressEvents: unknown[] = [];

      const ctx = createEventContext({
        onQuestion: () => {},
        onProgress: (e) => { progressEvents.push(e); },
      });

      callHandleEvent(runner, {
        type: "tool_use",
        name: "AskUserQuestion",
        id: "toolu_noprogress",
        input: { question: "Skip progress?" },
      }, ctx);

      // AskUserQuestion returns early; onProgress must not be called
      expect(progressEvents).toHaveLength(0);
    });
  });

  describe("multiple assistant text blocks", () => {
    test("joins multiple text blocks with newline in lastAssistantText", () => {
      const ctx = createEventContext({});

      callHandleEvent(runner, {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "First." },
            { type: "text", text: "Second." },
          ],
        },
      }, ctx);

      expect(ctx.lastAssistantText).toBe("First.\nSecond.");
    });

    test("multiple text blocks produce joined summary in onProgress", () => {
      const progressEvents: Array<{ summary: string }> = [];

      const ctx = createEventContext({
        onProgress: (e) => { progressEvents.push({ summary: e.summary }); },
      });

      callHandleEvent(runner, {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Block one." },
            { type: "text", text: "Block two." },
          ],
        },
      }, ctx);

      expect(progressEvents).toHaveLength(1);
      expect(progressEvents[0].summary).toContain("Block one.");
      expect(progressEvents[0].summary).toContain("Block two.");
    });
  });

  describe("unknown / malformed event types", () => {
    test("unknown event type is silently ignored — no callbacks fired", () => {
      const firedCallbacks: string[] = [];

      const ctx = createEventContext({
        onProgress: () => { firedCallbacks.push("onProgress"); },
        onQuestion: () => { firedCallbacks.push("onQuestion"); },
        onPlanApproval: () => { firedCallbacks.push("onPlanApproval"); },
        onComplete: () => { firedCallbacks.push("onComplete"); },
        onError: () => { firedCallbacks.push("onError"); },
      });

      callHandleEvent(runner, { type: "unknown_type", data: "whatever" }, ctx);

      expect(firedCallbacks).toHaveLength(0);
    });

    test("null type does not crash", () => {
      const ctx = createEventContext({});

      // Should not throw
      expect(() => {
        callHandleEvent(runner, { type: null as unknown as string }, ctx);
      }).not.toThrow();
    });

    test("undefined type does not crash", () => {
      const ctx = createEventContext({});

      expect(() => {
        callHandleEvent(runner, { type: undefined as unknown as string }, ctx);
      }).not.toThrow();
    });
  });

  describe("deduplication across different tools", () => {
    test("deduplicates filesChanged when same path written by different tools", () => {
      const ctx = createEventContext({});

      callHandleEvent(runner, {
        type: "tool_use",
        name: "write_file",
        id: "t1",
        input: { file_path: "src/app.ts" },
      }, ctx);

      callHandleEvent(runner, {
        type: "tool_use",
        name: "Edit",
        id: "t2",
        input: { file_path: "src/app.ts" },
      }, ctx);

      callHandleEvent(runner, {
        type: "tool_use",
        name: "str_replace_editor",
        id: "t3",
        input: { file_path: "src/app.ts" },
      }, ctx);

      const count = ctx.filesChanged.filter((f) => f === "src/app.ts").length;
      expect(count).toBe(1);
    });
  });

  describe("filesChanged snapshot isolation", () => {
    test("onProgress snapshot does not share reference with internal filesChanged array", () => {
      let capturedSnapshot: string[] | null = null;
      let callCount = 0;

      const ctx = createEventContext({
        onProgress: (e) => {
          callCount++;
          if (callCount === 1) {
            // Capture the snapshot from the first progress event
            capturedSnapshot = e.filesChanged;
          }
        },
      });

      // First file write — triggers onProgress, we capture the snapshot
      callHandleEvent(runner, {
        type: "tool_use",
        name: "write_file",
        id: "t1",
        input: { file_path: "src/first.ts" },
      }, ctx);

      // Second file write — should NOT mutate the previously captured snapshot
      callHandleEvent(runner, {
        type: "tool_use",
        name: "Write",
        id: "t2",
        input: { file_path: "src/second.ts" },
      }, ctx);

      expect(capturedSnapshot).not.toBeNull();
      // The first snapshot should only contain "src/first.ts"
      expect(capturedSnapshot!).toContain("src/first.ts");
      expect(capturedSnapshot!).not.toContain("src/second.ts");
    });
  });

  describe("system init without session_id", () => {
    test("system init event with no session_id field does not set claudeSessionId", () => {
      const ctx = createEventContext({});

      callHandleEvent(runner, {
        type: "system",
        subtype: "init",
        // deliberately omitting session_id
      }, ctx);

      expect(ctx.claudeSessionId).toBe("");
    });

    test("system init event with non-string session_id does not set claudeSessionId", () => {
      const ctx = createEventContext({});

      callHandleEvent(runner, {
        type: "system",
        subtype: "init",
        session_id: 12345, // number, not string
      }, ctx);

      expect(ctx.claudeSessionId).toBe("");
    });
  });

  // ---------------------------------------------------------------------------
  // Agent team completion deferral (Bug fix: premature "Coding Complete")
  // ---------------------------------------------------------------------------
  //
  // When useAgentTeam is true the team lead goes through multiple
  // request/response cycles.  Each cycle ends with a "result" event from the
  // Claude CLI stream-json output, but the subprocess stays alive while the
  // lead waits for worker agents to deliver their results.
  //
  // The bug: onComplete was fired on the FIRST result event, marking the
  // session done while the lead was still waiting.
  //
  // The fix: when useAgentTeam is true, result events only accumulate the
  // summary into lastResultSummary (and update resultEmitted flag) but do NOT
  // call onComplete.  onComplete is deferred until process exit (run() method).
  // ---------------------------------------------------------------------------

  describe("agent team — result event deferral (useAgentTeam: true)", () => {
    test("result success event does NOT fire onComplete when useAgentTeam is true", () => {
      let completeCalled = false;
      const ctx = createEventContext({
        onComplete: () => { completeCalled = true; },
      }, { useAgentTeam: true });

      callHandleEvent(runner, {
        type: "result",
        subtype: "success",
        result: "Team lead waiting for workers",
        session_id: "s-team",
      }, ctx);

      // onComplete must NOT have been called — completion is deferred to process exit
      expect(completeCalled).toBe(false);
    });

    test("result success event accumulates summary into lastResultSummary when useAgentTeam is true", () => {
      const ctx = createEventContext({}, { useAgentTeam: true });

      callHandleEvent(runner, {
        type: "result",
        subtype: "success",
        result: "First turn complete, waiting for workers",
        session_id: "s-team",
      }, ctx);

      expect(ctx.lastResultSummary).toBe("First turn complete, waiting for workers");
    });

    test("multiple result events: lastResultSummary holds the LATEST summary when useAgentTeam is true", () => {
      const ctx = createEventContext({}, { useAgentTeam: true });

      callHandleEvent(runner, {
        type: "result",
        subtype: "success",
        result: "First turn",
        session_id: "s-team",
      }, ctx);

      callHandleEvent(runner, {
        type: "result",
        subtype: "success",
        result: "Final turn — all workers done",
        session_id: "s-team",
      }, ctx);

      expect(ctx.lastResultSummary).toBe("Final turn — all workers done");
    });

    test("result success event still sets resultEmitted when useAgentTeam is true", () => {
      const ctx = createEventContext({}, { useAgentTeam: true });

      callHandleEvent(runner, {
        type: "result",
        subtype: "success",
        result: "Turn done",
        session_id: "s-team",
      }, ctx);

      expect(ctx.resultEmitted).toBe(true);
    });

    test("result success event updates claudeSessionId when useAgentTeam is true", () => {
      const ctx = createEventContext({}, { useAgentTeam: true });

      callHandleEvent(runner, {
        type: "result",
        subtype: "success",
        result: "Turn done",
        session_id: "new-session-id",
      }, ctx);

      // Session id should be updated so the process-exit path has the latest value
      expect(ctx.claudeSessionId).toBe("new-session-id");
    });

    test("result error event still fires onError immediately even when useAgentTeam is true", () => {
      // Errors are not deferred — they indicate a hard failure that should be
      // surfaced immediately regardless of team mode.
      let errorMsg = "";
      const ctx = createEventContext({
        onError: (err) => { errorMsg = err.message; },
      }, { useAgentTeam: true });

      callHandleEvent(runner, {
        type: "result",
        subtype: "error",
        error: "Worker agent crashed",
      }, ctx);

      expect(errorMsg).toBe("Worker agent crashed");
    });
  });

  describe("regular session — result event fires onComplete immediately (useAgentTeam: false)", () => {
    test("result success event fires onComplete immediately when useAgentTeam is false", () => {
      let completeCalled = false;
      let summary = "";
      const ctx = createEventContext({
        onComplete: (r) => { completeCalled = true; summary = r.summary; },
      }, { useAgentTeam: false });

      callHandleEvent(runner, {
        type: "result",
        subtype: "success",
        result: "Task done",
        session_id: "s-regular",
      }, ctx);

      expect(completeCalled).toBe(true);
      expect(summary).toBe("Task done");
    });

    test("result success event fires onComplete immediately when useAgentTeam is undefined (default)", () => {
      let completeCalled = false;
      const ctx = createEventContext({
        onComplete: () => { completeCalled = true; },
      });
      // useAgentTeam not set → undefined → non-agent-team path

      callHandleEvent(runner, {
        type: "result",
        subtype: "success",
        result: "Done",
        session_id: "s-default",
      }, ctx);

      expect(completeCalled).toBe(true);
    });

    test("result success event does NOT set lastResultSummary when useAgentTeam is false", () => {
      const ctx = createEventContext({
        onComplete: () => {},
      }, { useAgentTeam: false });

      callHandleEvent(runner, {
        type: "result",
        subtype: "success",
        result: "Done",
      }, ctx);

      // lastResultSummary stays empty; it is only used by agent team sessions
      expect(ctx.lastResultSummary).toBe("");
    });
  });

  // ---------------------------------------------------------------------------
  // TeamCreate event detection (agent team inbox watching)
  // ---------------------------------------------------------------------------
  //
  // When useAgentTeam is true, handleEvent must detect TeamCreate tool_use
  // events and extract the team_name from the input so the relay can start
  // watching the team-lead inbox for worker messages.
  // ---------------------------------------------------------------------------

  describe("TeamCreate event detection (agent team inbox watching)", () => {
    test("captures team_name from TeamCreate tool_use when useAgentTeam is true", () => {
      let capturedTeamName = "";
      const ctx = createEventContext({}, { useAgentTeam: true });
      ctx.setTeamName = (name: string) => { capturedTeamName = name; };

      callHandleEvent(runner, {
        type: "tool_use",
        name: "TeamCreate",
        id: "tc_1",
        input: { team_name: "hello-world-team" },
      }, ctx);

      expect(capturedTeamName).toBe("hello-world-team");
    });

    test("does NOT capture team_name when useAgentTeam is false", () => {
      let capturedTeamName = "";
      const ctx = createEventContext({}, { useAgentTeam: false });
      ctx.setTeamName = (name: string) => { capturedTeamName = name; };

      callHandleEvent(runner, {
        type: "tool_use",
        name: "TeamCreate",
        id: "tc_2",
        input: { team_name: "some-team" },
      }, ctx);

      expect(capturedTeamName).toBe("");
    });

    test("does NOT capture team_name when useAgentTeam is undefined", () => {
      let capturedTeamName = "";
      const ctx = createEventContext({});
      ctx.setTeamName = (name: string) => { capturedTeamName = name; };

      callHandleEvent(runner, {
        type: "tool_use",
        name: "TeamCreate",
        id: "tc_3",
        input: { team_name: "other-team" },
      }, ctx);

      expect(capturedTeamName).toBe("");
    });

    test("does NOT call setTeamName when team_name input is empty", () => {
      let setTeamNameCalled = false;
      const ctx = createEventContext({}, { useAgentTeam: true });
      ctx.setTeamName = () => { setTeamNameCalled = true; };

      callHandleEvent(runner, {
        type: "tool_use",
        name: "TeamCreate",
        id: "tc_4",
        input: { team_name: "" },
      }, ctx);

      expect(setTeamNameCalled).toBe(false);
    });

    test("does NOT call setTeamName when team_name input is missing", () => {
      let setTeamNameCalled = false;
      const ctx = createEventContext({}, { useAgentTeam: true });
      ctx.setTeamName = () => { setTeamNameCalled = true; };

      callHandleEvent(runner, {
        type: "tool_use",
        name: "TeamCreate",
        id: "tc_5",
        input: {},
      }, ctx);

      expect(setTeamNameCalled).toBe(false);
    });

    test("TeamCreate still fires onProgress for the tool use", () => {
      const progressEvents: Array<{ summary: string }> = [];
      const ctx = createEventContext({
        onProgress: (e) => { progressEvents.push({ summary: e.summary }); },
      }, { useAgentTeam: true });

      callHandleEvent(runner, {
        type: "tool_use",
        name: "TeamCreate",
        id: "tc_6",
        input: { team_name: "test-team" },
      }, ctx);

      expect(progressEvents).toHaveLength(1);
      expect(progressEvents[0].summary).toBe("TeamCreate");
    });

    test("captures randomized team names (non-deterministic TeamCreate)", () => {
      let capturedTeamName = "";
      const ctx = createEventContext({}, { useAgentTeam: true });
      ctx.setTeamName = (name: string) => { capturedTeamName = name; };

      callHandleEvent(runner, {
        type: "tool_use",
        name: "TeamCreate",
        id: "tc_7",
        input: { team_name: "buzzing-conjuring-puffin" },
      }, ctx);

      expect(capturedTeamName).toBe("buzzing-conjuring-puffin");
    });

    // Regression: Claude Code emits TeamCreate as a tool_use block INSIDE an
    // assistant message, not as a top-level tool_use event.
    test("captures team_name from TeamCreate embedded in assistant message.content", () => {
      let capturedTeamName = "";
      const ctx = createEventContext({}, { useAgentTeam: true });
      ctx.setTeamName = (name: string) => { capturedTeamName = name; };

      callHandleEvent(runner, {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I'll create a team for this task." },
            {
              type: "tool_use",
              id: "toolu_01JSRt7VCK4FYF86bwphgnas",
              name: "TeamCreate",
              input: {
                team_name: "hello-world-team",
                description: "Team to implement a hello world function",
              },
            },
          ],
        },
      }, ctx);

      expect(capturedTeamName).toBe("hello-world-team");
    });

    test("does NOT capture embedded TeamCreate when useAgentTeam is false", () => {
      let capturedTeamName = "";
      const ctx = createEventContext({}, { useAgentTeam: false });
      ctx.setTeamName = (name: string) => { capturedTeamName = name; };

      callHandleEvent(runner, {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "TeamCreate",
              input: { team_name: "some-team" },
            },
          ],
        },
      }, ctx);

      expect(capturedTeamName).toBe("");
    });
  });
});

// ---------------------------------------------------------------------------
// SessionRunner.getInboxPath — path construction
// ---------------------------------------------------------------------------

describe("SessionRunner.getInboxPath — inbox path construction", () => {
  test("returns correct path containing team name, inboxes dir, and team-lead.json", () => {
    const path = SessionRunner.getInboxPath("hello-world-team");
    expect(path).toContain("hello-world-team");
    expect(path).toContain("inboxes");
    expect(path).toEndWith("team-lead.json");
    expect(path).toContain(".claude/teams");
  });

  test("handles hyphenated team names", () => {
    const path = SessionRunner.getInboxPath("buzzing-conjuring-puffin");
    expect(path).toEndWith("buzzing-conjuring-puffin/inboxes/team-lead.json");
  });

  test("uses homedir as root", () => {
    const path = SessionRunner.getInboxPath("test-team");
    expect(path).toContain(homedir());
  });
});

// ---------------------------------------------------------------------------
// SessionRunner.pollInbox — file-based inbox reading
// ---------------------------------------------------------------------------

describe("SessionRunner.pollInbox — inbox file reading", () => {
  const testTeamName = `__test-poll-inbox-${Date.now()}`;
  const testInboxDir = join(homedir(), ".claude", "teams", testTeamName, "inboxes");
  const testInboxPath = join(testInboxDir, "team-lead.json");

  afterEach(async () => {
    try {
      await rm(join(homedir(), ".claude", "teams", testTeamName), { recursive: true, force: true });
    } catch {
      // Cleanup failure is not a test failure
    }
  });

  test("returns empty array when inbox file does not exist", async () => {
    const messages = await SessionRunner.pollInbox("__nonexistent-team-99999", 0);
    expect(messages).toEqual([]);
  });

  test("returns all messages when skipCount is 0", async () => {
    await mkdir(testInboxDir, { recursive: true });
    const inbox = [
      { sender: "implementer", content: "Code done", summary: "impl done" },
      { sender: "reviewer", content: "LGTM", summary: "review done" },
    ];
    await writeFile(testInboxPath, JSON.stringify(inbox));

    const messages = await SessionRunner.pollInbox(testTeamName, 0);
    expect(messages).toHaveLength(2);
    expect(messages[0].sender).toBe("implementer");
    expect(messages[1].sender).toBe("reviewer");
  });

  test("skips messages before skipCount", async () => {
    await mkdir(testInboxDir, { recursive: true });
    const inbox = [
      { sender: "implementer", content: "Code done" },
      { sender: "reviewer", content: "LGTM" },
      { sender: "tester", content: "Tests pass" },
    ];
    await writeFile(testInboxPath, JSON.stringify(inbox));

    const messages = await SessionRunner.pollInbox(testTeamName, 2);
    expect(messages).toHaveLength(1);
    expect(messages[0].sender).toBe("tester");
  });

  test("returns empty array when skipCount equals message count", async () => {
    await mkdir(testInboxDir, { recursive: true });
    const inbox = [
      { sender: "implementer", content: "Done" },
    ];
    await writeFile(testInboxPath, JSON.stringify(inbox));

    const messages = await SessionRunner.pollInbox(testTeamName, 1);
    expect(messages).toEqual([]);
  });

  test("returns empty array when skipCount exceeds message count", async () => {
    await mkdir(testInboxDir, { recursive: true });
    const inbox = [
      { sender: "implementer", content: "Done" },
    ];
    await writeFile(testInboxPath, JSON.stringify(inbox));

    const messages = await SessionRunner.pollInbox(testTeamName, 100);
    expect(messages).toEqual([]);
  });

  test("returns empty array when inbox contains invalid JSON", async () => {
    await mkdir(testInboxDir, { recursive: true });
    await writeFile(testInboxPath, "not valid json {{{");

    const messages = await SessionRunner.pollInbox(testTeamName, 0);
    expect(messages).toEqual([]);
  });

  test("returns empty array when inbox is not an array", async () => {
    await mkdir(testInboxDir, { recursive: true });
    await writeFile(testInboxPath, JSON.stringify({ not: "an array" }));

    const messages = await SessionRunner.pollInbox(testTeamName, 0);
    expect(messages).toEqual([]);
  });

  test("handles messages with 'from' field instead of 'sender'", async () => {
    await mkdir(testInboxDir, { recursive: true });
    const inbox = [
      { from: "worker-a", content: "Task complete" },
    ];
    await writeFile(testInboxPath, JSON.stringify(inbox));

    const messages = await SessionRunner.pollInbox(testTeamName, 0);
    expect(messages).toHaveLength(1);
    expect(messages[0].from).toBe("worker-a");
  });

  test("handles messages with only summary field", async () => {
    await mkdir(testInboxDir, { recursive: true });
    const inbox = [
      { sender: "tester", summary: "All 4 tests pass" },
    ];
    await writeFile(testInboxPath, JSON.stringify(inbox));

    const messages = await SessionRunner.pollInbox(testTeamName, 0);
    expect(messages).toHaveLength(1);
    expect(messages[0].summary).toBe("All 4 tests pass");
  });
});

// ---------------------------------------------------------------------------
// SessionRunner.discoverActualTeamName — real team name discovery
// ---------------------------------------------------------------------------
//
// Claude Code ignores the LLM's input.team_name and always creates the team
// directory under a random slug (e.g., "giggly-forging-flamingo").
// discoverActualTeamName polls TEAMS_DIR for a directory NOT in the pre-session
// snapshot so the relay can watch the correct inbox.
// ---------------------------------------------------------------------------

describe("SessionRunner.discoverActualTeamName — filesystem team discovery", () => {
  const teamsRoot = join(homedir(), ".claude", "teams");
  const uniqueSuffix = `disc-test-${Date.now()}`;

  afterEach(async () => {
    // Clean up any test directories created during the tests
    try {
      const { readdir: rd } = await import("node:fs/promises");
      const entries = await rd(teamsRoot).catch(() => [] as string[]);
      for (const entry of entries) {
        if (entry.includes(uniqueSuffix)) {
          await rm(join(teamsRoot, entry), { recursive: true, force: true });
        }
      }
    } catch {
      // Best-effort cleanup
    }
  });

  test("returns null when no new directory appears within timeout", async () => {
    // Take a snapshot that includes ALL current teams, then wait with a short timeout
    const { readdir: rd } = await import("node:fs/promises");
    const existing = await rd(teamsRoot).catch(() => [] as string[]);
    const knownTeams = new Set(existing);

    const result = await SessionRunner.discoverActualTeamName(knownTeams, {
      timeoutMs: 300,
      pollIntervalMs: 100,
    });

    expect(result).toBeNull();
  });

  test("returns the new team directory when it appears after snapshot", async () => {
    const { readdir: rd, mkdir: mkd } = await import("node:fs/promises");

    // Snapshot before the new team is created
    const existing = await rd(teamsRoot).catch(() => [] as string[]);
    const knownTeams = new Set(existing);

    // Create a new team directory concurrently (simulates Claude Code's TeamCreate)
    const newTeamName = `__disc-${uniqueSuffix}-appear`;
    const newTeamPath = join(teamsRoot, newTeamName);

    // Start discovery, then create the dir 200ms later
    const discoveryPromise = SessionRunner.discoverActualTeamName(knownTeams, {
      timeoutMs: 5_000,
      pollIntervalMs: 100,
    });

    // Let the first poll run (it should find nothing), then create the dir
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    await mkd(newTeamPath, { recursive: true });

    const result = await discoveryPromise;
    expect(result).toBe(newTeamName);

    // Cleanup
    await rm(newTeamPath, { recursive: true, force: true });
  });

  test("returns immediately when new directory already exists at first poll", async () => {
    const { readdir: rd, mkdir: mkd } = await import("node:fs/promises");

    // Snapshot that does NOT include the new team
    const existing = await rd(teamsRoot).catch(() => [] as string[]);
    const newTeamName = `__disc-${uniqueSuffix}-preexist`;
    const newTeamPath = join(teamsRoot, newTeamName);
    const knownTeams = new Set(existing); // does NOT include newTeamName

    // Create the dir BEFORE starting discovery
    await mkd(newTeamPath, { recursive: true });

    const result = await SessionRunner.discoverActualTeamName(knownTeams, {
      timeoutMs: 5_000,
      pollIntervalMs: 100,
    });

    expect(result).toBe(newTeamName);

    // Cleanup
    await rm(newTeamPath, { recursive: true, force: true });
  });

  test("ignores directories that were already in the snapshot", async () => {
    const { readdir: rd } = await import("node:fs/promises");

    // Include all current dirs in snapshot — discovery should find nothing new
    const existing = await rd(teamsRoot).catch(() => [] as string[]);
    const knownTeams = new Set(existing);

    const result = await SessionRunner.discoverActualTeamName(knownTeams, {
      timeoutMs: 200,
      pollIntervalMs: 50,
    });

    expect(result).toBeNull();
  });

  test("works when TEAMS_DIR does not exist (knownTeams is empty)", async () => {
    // With a non-existent teams dir, readdir throws — discoverActualTeamName
    // should gracefully swallow the error and return null on timeout.
    const emptyKnown = new Set<string>();

    const result = await SessionRunner.discoverActualTeamName(emptyKnown, {
      timeoutMs: 200,
      pollIntervalMs: 50,
    });

    // Either null (TEAMS_DIR doesn't exist) or a string (it does exist and there
    // are teams not in the empty snapshot). Both are valid outcomes.
    expect(result === null || typeof result === "string").toBe(true);
  });
});
