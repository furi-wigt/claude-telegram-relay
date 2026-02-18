import { describe, test, expect, mock, beforeEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import { homedir } from "os";
import { resolve } from "path";
import type { Bot, Context } from "grammy";
import { registerCodingCommands } from "./codingCommands.ts";
import type { CodingSessionManager } from "./sessionManager.ts";
import type { InputRouter } from "./inputRouter.ts";
import type { CodingSession } from "./types.ts";

// ---------------------------------------------------------------------------
// Mock factory helpers
// ---------------------------------------------------------------------------

function createMockBot() {
  const handlers: Map<string, Function[]> = new Map();
  const eventHandlers: Map<string, Function[]> = new Map();

  const bot = {
    command: mock((cmd: string, handler: Function) => {
      const existing = handlers.get(cmd) || [];
      existing.push(handler);
      handlers.set(cmd, existing);
    }),
    on: mock((event: string, handler: Function) => {
      const existing = eventHandlers.get(event) || [];
      existing.push(handler);
      eventHandlers.set(event, existing);
    }),
  } as unknown as Bot;

  return { bot, handlers, eventHandlers };
}

/**
 * Build a mock Context and trigger the "code" command with the given match string.
 * Returns all reply texts sent via ctx.reply().
 */
async function triggerCode(
  handlers: Map<string, Function[]>,
  match: string,
  chatId = 12345
): Promise<string[]> {
  const replies: string[] = [];
  const ctx = {
    match,
    chat: { id: chatId },
    callbackQuery: undefined,
    reply: mock(async (text: string) => {
      replies.push(text);
      return { message_id: 1 };
    }),
  } as unknown as Context;

  const commandHandlers = handlers.get("code") || [];
  for (const h of commandHandlers) {
    await h(ctx);
  }
  return replies;
}

function makeSession(overrides: Partial<CodingSession> = {}): CodingSession {
  return {
    id: "abcdef1234567890",
    chatId: 12345,
    directory: "/Users/test/my-project",
    projectName: "my-project",
    task: "Add OAuth authentication",
    status: "running",
    useAgentTeam: false,
    startedAt: new Date(Date.now() - 90_000).toISOString(), // 1.5 min ago
    lastActivityAt: new Date().toISOString(),
    filesChanged: [],
    source: "bot",
    ...overrides,
  };
}

function createMockSessionManager(sessions: CodingSession[] = []) {
  return {
    listForChat: mock((_chatId: number) => sessions),
    listAll: mock(async (_chatId: number) => sessions),
    getMostRecentActive: mock((_chatId: number) =>
      sessions.find((s) => s.status === "running" || s.status === "waiting_for_input") ??
      undefined
    ),
    getSession: mock((id: string) => sessions.find((s) => s.id === id) ?? undefined),
    getStatusText: mock((_id: string) => "Status: running\nTask: Add OAuth"),
    getLogs: mock(async (_id: string) => "Line 1\nLine 2"),
    getDiff: mock(async (_id: string) => "diff --git a/foo.ts b/foo.ts"),
    killSession: mock(async (_id: string) => {}),
    startSession: mock(async (_chatId: number, _ctx: Context, _opts: unknown) => ({
      id: "new-session-id",
      status: "running",
      projectName: "my-project",
    })),
    getPermissionManager: mock(() => ({
      listPermitted: mock(async () => []),
      grant: mock(async () => {}),
      revoke: mock(async () => false),
    })),
    syncDesktopSessions: mock(async (_chatId: number) => {}),
    answerCurrentWaiting: mock(async (_chatId: number, _text: string) => {}),
    launchSession: mock(async (_session: CodingSession) => {}),
    // Returns a fake Claude session ID to simulate the NDJSON system init event
    waitForClaudeSessionId: mock(async (_sessionId: string) => "fa97d3a7-de3f-4e22-9740-57fa1ec8fe7a"),
  } as unknown as CodingSessionManager;
}

function createMockInputRouter() {
  return {
    handleCallbackQuery: mock(async () => {}),
  } as unknown as InputRouter;
}

/**
 * Creates a mock session manager whose startSession returns pending_permission.
 * Use this for --team tests to prevent handleNew from calling analyzeTaskForTeam
 * (which would wait on Claude CLI). The session args are still captured for assertion.
 */
function createPendingSessionManager() {
  const sm = createMockSessionManager();
  (sm.startSession as ReturnType<typeof mock>).mockImplementation(
    async (_chatId: number, _ctx: unknown, _opts: unknown) => ({
      id: "new-session-id",
      status: "pending_permission",
      projectName: "my-project",
    })
  );
  return sm;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registerCodingCommands", () => {
  describe("handleHelp — /code help and /code (no subcommand)", () => {
    test("shows help text with key command names", async () => {
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, createMockSessionManager(), createMockInputRouter());

      const replies = await triggerCode(handlers, "help");
      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain("/code list");
      expect(replies[0]).toContain("/code new");
      expect(replies[0]).toContain("/code status");
      expect(replies[0]).toContain("/code logs");
      expect(replies[0]).toContain("/code stop");
    });

    test("empty match (no subcommand) also shows help", async () => {
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, createMockSessionManager(), createMockInputRouter());

      const replies = await triggerCode(handlers, "");
      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain("Agentic Coding Commands");
    });

    test("unknown subcommand falls back to help", async () => {
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, createMockSessionManager(), createMockInputRouter());

      const replies = await triggerCode(handlers, "foobar");
      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain("Agentic Coding Commands");
    });
  });

  describe("handleList — /code list", () => {
    test("empty sessions returns 'No coding sessions found.'", async () => {
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, createMockSessionManager([]), createMockInputRouter());

      const replies = await triggerCode(handlers, "list");
      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain("No coding sessions found.");
    });

    test("single session shows project name, task, and short ID", async () => {
      const session = makeSession();
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, createMockSessionManager([session]), createMockInputRouter());

      const replies = await triggerCode(handlers, "list");
      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain("my-project");
      expect(replies[0]).toContain("Add OAuth authentication");
      expect(replies[0]).toContain(session.id.slice(0, 6));
    });

    test("desktop session shows '[desktop]' label", async () => {
      const session = makeSession({ source: "desktop" });
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, createMockSessionManager([session]), createMockInputRouter());

      const replies = await triggerCode(handlers, "list");
      expect(replies[0]).toContain("[desktop]");
    });

    test("bot session does NOT show '[desktop]' label", async () => {
      const session = makeSession({ source: "bot" });
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, createMockSessionManager([session]), createMockInputRouter());

      const replies = await triggerCode(handlers, "list");
      expect(replies[0]).not.toContain("[desktop]");
    });

    test("task longer than 60 chars is truncated with ellipsis", async () => {
      const longTask = "A".repeat(70);
      const session = makeSession({ task: longTask });
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, createMockSessionManager([session]), createMockInputRouter());

      const replies = await triggerCode(handlers, "list");
      expect(replies[0]).toContain("...");
      // The displayed task should be max 63 chars (60 + "...")
      expect(replies[0]).not.toContain(longTask);
    });

    test("multiple sessions all appear in one reply", async () => {
      const s1 = makeSession({ id: "aaaa0001", projectName: "alpha", task: "task-alpha" });
      const s2 = makeSession({ id: "bbbb0002", projectName: "beta", task: "task-beta" });
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, createMockSessionManager([s1, s2]), createMockInputRouter());

      const replies = await triggerCode(handlers, "list");
      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain("alpha");
      expect(replies[0]).toContain("beta");
    });
  });

  describe("handleNew — /code new <path> <task>", () => {
    test("no args returns usage message", async () => {
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, createMockSessionManager(), createMockInputRouter());

      const replies = await triggerCode(handlers, "new");
      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain("Usage: /code new");
    });

    test("path only (no task) returns 'Please provide a task description'", async () => {
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, createMockSessionManager(), createMockInputRouter());

      const replies = await triggerCode(handlers, "new ~/project");
      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain("Please provide a task description");
    });

    test("--team flag with no task also returns error", async () => {
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, createMockSessionManager(), createMockInputRouter());

      // "new ~/project --team" — path=~/project, tokens after=[--team], task="" after filter
      const replies = await triggerCode(handlers, "new ~/project --team");
      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain("Please provide a task description");
    });

    test("tilde path is expanded to absolute path", async () => {
      const sm = createMockSessionManager();
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, sm, createMockInputRouter());

      await triggerCode(handlers, "new ~/myproject Do something");

      expect(sm.startSession).toHaveBeenCalledTimes(1);
      const callArgs = (sm.startSession as ReturnType<typeof mock>).mock.calls[0];
      const opts = callArgs[2] as { directory: string; task: string; useAgentTeam: boolean };
      expect(opts.directory).toBe(resolve(homedir(), "myproject"));
      expect(opts.directory.startsWith("/")).toBe(true);
    });

    test("relative path (no ~ or /) is resolved relative to homedir", async () => {
      const sm = createMockSessionManager();
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, sm, createMockInputRouter());

      await triggerCode(handlers, "new myproject Do something");

      const callArgs = (sm.startSession as ReturnType<typeof mock>).mock.calls[0];
      const opts = callArgs[2] as { directory: string; task: string; useAgentTeam: boolean };
      expect(opts.directory).toBe(resolve(homedir(), "myproject"));
    });

    test("absolute path is passed through unchanged", async () => {
      const sm = createMockSessionManager();
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, sm, createMockInputRouter());

      await triggerCode(handlers, "new /absolute/path Do something");

      const callArgs = (sm.startSession as ReturnType<typeof mock>).mock.calls[0];
      const opts = callArgs[2] as { directory: string; task: string; useAgentTeam: boolean };
      expect(opts.directory).toBe("/absolute/path");
    });

    test("--team flag sets useAgentTeam=true", async () => {
      // Use pending_permission so handleNew returns before calling analyzeTaskForTeam
      const sm = createPendingSessionManager();
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, sm, createMockInputRouter());

      await triggerCode(handlers, "new ~/project --team Add auth");

      const callArgs = (sm.startSession as ReturnType<typeof mock>).mock.calls[0];
      const opts = callArgs[2] as { directory: string; task: string; useAgentTeam: boolean };
      expect(opts.useAgentTeam).toBe(true);
    });

    test("without --team flag, useAgentTeam=false", async () => {
      const sm = createMockSessionManager();
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, sm, createMockInputRouter());

      await triggerCode(handlers, "new ~/project Add auth");

      const callArgs = (sm.startSession as ReturnType<typeof mock>).mock.calls[0];
      const opts = callArgs[2] as { directory: string; task: string; useAgentTeam: boolean };
      expect(opts.useAgentTeam).toBe(false);
    });

    test("task text excludes --team flag", async () => {
      // Use pending_permission so handleNew returns before calling analyzeTaskForTeam
      const sm = createPendingSessionManager();
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, sm, createMockInputRouter());

      await triggerCode(handlers, "new ~/project --team Add auth feature");

      const callArgs = (sm.startSession as ReturnType<typeof mock>).mock.calls[0];
      const opts = callArgs[2] as { directory: string; task: string; useAgentTeam: boolean };
      expect(opts.task).toBe("Add auth feature");
      expect(opts.task).not.toContain("--team");
    });

    test("success reply contains Claude session ID prefix (not relay ID) and project name", async () => {
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, createMockSessionManager(), createMockInputRouter());

      const replies = await triggerCode(handlers, "new ~/myproject Do something");
      // First reply is the "Starting..." message
      expect(replies[0]).toContain("Starting");
      // Second reply is the success message — should show the Claude Code session ID
      const successReply = replies.find((r) => r.includes("Started coding session"));
      expect(successReply).toBeDefined();
      // The mock waitForClaudeSessionId returns "fa97d3a7-de3f-4e22-9740-57fa1ec8fe7a"
      // so the display ID should be the first 8 chars of the Claude session ID
      expect(successReply).toContain("fa97d3a7");
      // The relay's internal ID ("new-sessi") must NOT appear
      expect(successReply).not.toContain("new-sessi");
    });

    test("success reply falls back to relay ID prefix when Claude session ID is not available", async () => {
      const sm = createMockSessionManager();
      // Simulate waitForClaudeSessionId timing out (returns undefined)
      (sm.waitForClaudeSessionId as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, sm, createMockInputRouter());

      const replies = await triggerCode(handlers, "new ~/myproject Do something");
      const successReply = replies.find((r) => r.includes("Started coding session"));
      expect(successReply).toBeDefined();
      // Falls back to the relay's internal ID when Claude session ID is unavailable
      expect(successReply).toContain("new-session-id".slice(0, 8));
    });

    test("startSession error shows failure message", async () => {
      const sm = createMockSessionManager();
      (sm.startSession as ReturnType<typeof mock>).mockImplementationOnce(async () => {
        throw new Error("Disk full");
      });
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, sm, createMockInputRouter());

      const replies = await triggerCode(handlers, "new ~/project Do something");
      const errorReply = replies.find((r) => r.includes("Failed to start session"));
      expect(errorReply).toBeDefined();
      expect(errorReply).toContain("Disk full");
    });

    test("pending_permission status returns without success reply", async () => {
      const sm = createMockSessionManager();
      (sm.startSession as ReturnType<typeof mock>).mockImplementationOnce(async () => ({
        id: "perm-session",
        status: "pending_permission",
        projectName: "secured-project",
      }));
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, sm, createMockInputRouter());

      const replies = await triggerCode(handlers, "new ~/secured Do something");
      // Only the "Starting..." reply — no success reply
      const successReply = replies.find((r) => r.includes("Started coding session"));
      expect(successReply).toBeUndefined();
    });

    test("quoted double-quote path with spaces is parsed correctly", async () => {
      const sm = createMockSessionManager();
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, sm, createMockInputRouter());

      await triggerCode(handlers, 'new "/tmp/my test project" List files');

      expect(sm.startSession).toHaveBeenCalledTimes(1);
      const callArgs = (sm.startSession as ReturnType<typeof mock>).mock.calls[0];
      const opts = callArgs[2] as { directory: string; task: string; useAgentTeam: boolean };
      // Directory should contain the space-including path
      expect(opts.directory).toContain("my test project");
      expect(opts.task).toBe("List files");
    });

    test("quoted single-quote path with spaces is parsed correctly", async () => {
      const sm = createMockSessionManager();
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, sm, createMockInputRouter());

      await triggerCode(handlers, "new '/tmp/my test project' List files");

      expect(sm.startSession).toHaveBeenCalledTimes(1);
      const callArgs = (sm.startSession as ReturnType<typeof mock>).mock.calls[0];
      const opts = callArgs[2] as { directory: string; task: string; useAgentTeam: boolean };
      expect(opts.directory).toContain("my test project");
      expect(opts.task).toBe("List files");
    });

    test("quoted path does not reply with 'Please provide a task'", async () => {
      const sm = createMockSessionManager();
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, sm, createMockInputRouter());

      const replies = await triggerCode(handlers, 'new "/tmp/my test project" List files');
      const errorReply = replies.find((r) => r.includes("Please provide a task"));
      expect(errorReply).toBeUndefined();
    });

    test("smart probing: uses longest existing path prefix", async () => {
      // Simulate /tmp existing on the filesystem
      const existsSyncSpy = spyOn(fs, "existsSync").mockImplementation((p) => {
        return String(p) === "/tmp/my";
      });

      const sm = createMockSessionManager();
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, sm, createMockInputRouter());

      try {
        await triggerCode(handlers, "new /tmp/my test project List files");

        expect(sm.startSession).toHaveBeenCalledTimes(1);
        const callArgs = (sm.startSession as ReturnType<typeof mock>).mock.calls[0];
        const opts = callArgs[2] as { directory: string; task: string; useAgentTeam: boolean };
        // Longest existing prefix is "/tmp/my", task is "test project List files"
        expect(opts.directory).toBe("/tmp/my");
        expect(opts.task).toBe("test project List files");
      } finally {
        existsSyncSpy.mockRestore();
      }
    });

    test("falls back to first token for non-existent paths (no quotes)", async () => {
      const sm = createMockSessionManager();
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, sm, createMockInputRouter());

      await triggerCode(handlers, "new /nonexistent/path Do something");

      expect(sm.startSession).toHaveBeenCalledTimes(1);
      const callArgs = (sm.startSession as ReturnType<typeof mock>).mock.calls[0];
      const opts = callArgs[2] as { directory: string; task: string; useAgentTeam: boolean };
      // First token is the path, rest is the task
      expect(opts.directory).toBe("/nonexistent/path");
      expect(opts.task).toBe("Do something");
    });

    test("quoted path works with --team flag", async () => {
      // Use pending_permission so handleNew returns before calling analyzeTaskForTeam
      const sm = createPendingSessionManager();
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, sm, createMockInputRouter());

      await triggerCode(handlers, 'new "/tmp/my project" Add tests --team');

      expect(sm.startSession).toHaveBeenCalledTimes(1);
      const callArgs = (sm.startSession as ReturnType<typeof mock>).mock.calls[0];
      const opts = callArgs[2] as { directory: string; task: string; useAgentTeam: boolean };
      expect(opts.useAgentTeam).toBe(true);
      expect(opts.directory).toContain("my project");
      expect(opts.task).toBe("Add tests");
    });

    test("usage message includes quoting syntax hint", async () => {
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, createMockSessionManager(), createMockInputRouter());

      const replies = await triggerCode(handlers, "new");
      expect(replies[0]).toContain("quotes");
    });
  });

  describe("handleStatus — /code status [id]", () => {
    test("no sessions and no args shows 'No active session found'", async () => {
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, createMockSessionManager([]), createMockInputRouter());

      const replies = await triggerCode(handlers, "status");
      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain("No active session found");
    });

    test("with active session and no args, uses most recent active session", async () => {
      const session = makeSession({ status: "running" });
      const sm = createMockSessionManager([session]);
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, sm, createMockInputRouter());

      const replies = await triggerCode(handlers, "status");
      expect(replies).toHaveLength(1);
      expect(sm.getStatusText).toHaveBeenCalledWith(session.id);
    });

    test("with partial session ID, prefix-matches and returns status", async () => {
      const session = makeSession({ id: "abcdef1234567890" });
      // Only running sessions are returned by getMostRecentActive
      // but listForChat returns all
      const sm = createMockSessionManager([session]);
      // Override getMostRecentActive to return undefined to force prefix match path
      (sm.getMostRecentActive as ReturnType<typeof mock>).mockImplementation(() => undefined);
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, sm, createMockInputRouter());

      // Use first 6 chars as partial ID
      const replies = await triggerCode(handlers, "status abcdef");
      expect(replies).toHaveLength(1);
      expect(sm.getStatusText).toHaveBeenCalledWith(session.id);
    });

    test("with non-existent session ID, shows 'No active session found'", async () => {
      const session = makeSession({ id: "abcdef1234567890" });
      const sm = createMockSessionManager([session]);
      (sm.getMostRecentActive as ReturnType<typeof mock>).mockImplementation(() => undefined);
      (sm.getSession as ReturnType<typeof mock>).mockImplementation(() => undefined);
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, sm, createMockInputRouter());

      const replies = await triggerCode(handlers, "status zzzzzzz");
      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain("No active session found");
    });

    test("status text from sessionManager is returned as reply", async () => {
      const session = makeSession();
      const sm = createMockSessionManager([session]);
      (sm.getStatusText as ReturnType<typeof mock>).mockReturnValue("Status: running\nFiles: 3 changed");
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, sm, createMockInputRouter());

      const replies = await triggerCode(handlers, "status");
      expect(replies[0]).toContain("Status: running");
      expect(replies[0]).toContain("Files: 3 changed");
    });
  });

  describe("handleLogs — /code logs [id]", () => {
    test("no sessions shows 'No active session found'", async () => {
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, createMockSessionManager([]), createMockInputRouter());

      const replies = await triggerCode(handlers, "logs");
      expect(replies[0]).toContain("No active session found");
    });

    test("with active session, returns log output", async () => {
      const session = makeSession();
      const sm = createMockSessionManager([session]);
      (sm.getLogs as ReturnType<typeof mock>).mockResolvedValue("Log line A\nLog line B");
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, sm, createMockInputRouter());

      const replies = await triggerCode(handlers, "logs");
      expect(replies[0]).toContain("Log line A");
      expect(replies[0]).toContain("Log line B");
    });
  });

  describe("handleDiff — /code diff [id]", () => {
    test("no sessions shows 'No active session found'", async () => {
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, createMockSessionManager([]), createMockInputRouter());

      const replies = await triggerCode(handlers, "diff");
      expect(replies[0]).toContain("No active session found");
    });

    test("with active session, returns diff output", async () => {
      const session = makeSession();
      const sm = createMockSessionManager([session]);
      (sm.getDiff as ReturnType<typeof mock>).mockResolvedValue("diff --git a/foo b/foo\n+new line");
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, sm, createMockInputRouter());

      const replies = await triggerCode(handlers, "diff");
      expect(replies[0]).toContain("diff --git");
    });
  });

  describe("handleStop — /code stop [id]", () => {
    test("no sessions shows 'No active session found to stop'", async () => {
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, createMockSessionManager([]), createMockInputRouter());

      const replies = await triggerCode(handlers, "stop");
      expect(replies[0]).toContain("No active session found to stop");
    });

    test("with active session, kills it and confirms", async () => {
      const session = makeSession();
      const sm = createMockSessionManager([session]);
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, sm, createMockInputRouter());

      const replies = await triggerCode(handlers, "stop");
      expect(sm.killSession).toHaveBeenCalledWith(session.id);
      expect(replies[0]).toContain("Session stopped");
    });
  });

  describe("handleAnswer — /code answer <text>", () => {
    test("no args shows usage message", async () => {
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, createMockSessionManager(), createMockInputRouter());

      const replies = await triggerCode(handlers, "answer");
      expect(replies[0]).toContain("Usage: /code answer");
    });

    test("with text, calls answerCurrentWaiting and confirms", async () => {
      const sm = createMockSessionManager();
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, sm, createMockInputRouter());

      const replies = await triggerCode(handlers, "answer Yes please do it");
      expect(sm.answerCurrentWaiting).toHaveBeenCalledWith(12345, "Yes please do it");
      expect(replies[0]).toContain("Answer sent");
    });

    test("answerCurrentWaiting error shows error message", async () => {
      const sm = createMockSessionManager();
      (sm.answerCurrentWaiting as ReturnType<typeof mock>).mockRejectedValueOnce(
        new Error("No waiting session")
      );
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, sm, createMockInputRouter());

      const replies = await triggerCode(handlers, "answer something");
      expect(replies[0]).toContain("No waiting session");
    });
  });

  describe("handlePerms — /code perms", () => {
    test("no permitted directories shows empty message", async () => {
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, createMockSessionManager(), createMockInputRouter());

      const replies = await triggerCode(handlers, "perms");
      expect(replies[0]).toContain("No directories permitted yet");
    });

    test("with permitted directories, lists them", async () => {
      const sm = createMockSessionManager();
      const pm = {
        listPermitted: mock(async () => [
          { path: "/Users/test/alpha", type: "exact" as const, grantedAt: "", grantedByChatId: 1 },
          { path: "/Users/test/beta", type: "prefix" as const, grantedAt: "", grantedByChatId: 1 },
        ]),
        grant: mock(async () => {}),
        revoke: mock(async () => false),
      };
      (sm.getPermissionManager as ReturnType<typeof mock>).mockReturnValue(pm);
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, sm, createMockInputRouter());

      const replies = await triggerCode(handlers, "perms");
      expect(replies[0]).toContain("/Users/test/alpha");
      expect(replies[0]).toContain("/Users/test/beta");
      expect(replies[0]).toContain("+ subdirs");
    });
  });

  describe("resolveSessionId — indirect via status/logs/diff/stop", () => {
    test("empty args with running session uses most recent active", async () => {
      const running = makeSession({ id: "run-session-id", status: "running" });
      const sm = createMockSessionManager([running]);
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, sm, createMockInputRouter());

      await triggerCode(handlers, "status");
      expect(sm.getStatusText).toHaveBeenCalledWith("run-session-id");
    });

    test("empty args with no active session falls back to any session in chat", async () => {
      const completed = makeSession({ id: "completed-id", status: "completed" });
      const sm = createMockSessionManager([completed]);
      // getMostRecentActive returns undefined (no active)
      (sm.getMostRecentActive as ReturnType<typeof mock>).mockReturnValue(undefined);
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, sm, createMockInputRouter());

      await triggerCode(handlers, "status");
      expect(sm.getStatusText).toHaveBeenCalledWith("completed-id");
    });

    test("exact ID provided is used directly", async () => {
      const session = makeSession({ id: "exact-full-id-12345" });
      const sm = createMockSessionManager([session]);
      (sm.getSession as ReturnType<typeof mock>).mockImplementation((id: string) =>
        id === "exact-full-id-12345" ? session : undefined
      );
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, sm, createMockInputRouter());

      await triggerCode(handlers, "status exact-full-id-12345");
      expect(sm.getStatusText).toHaveBeenCalledWith("exact-full-id-12345");
    });

    test("prefix match on short ID resolves to full ID", async () => {
      const session = makeSession({ id: "prefix-match-full-12345" });
      const sm = createMockSessionManager([session]);
      // getSession returns undefined (no exact match for short ID)
      (sm.getSession as ReturnType<typeof mock>).mockImplementation(() => undefined);
      (sm.getMostRecentActive as ReturnType<typeof mock>).mockReturnValue(undefined);
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, sm, createMockInputRouter());

      await triggerCode(handlers, "status prefix-m");
      expect(sm.getStatusText).toHaveBeenCalledWith("prefix-match-full-12345");
    });
  });

  describe("handleScan — /code scan", () => {
    test("no desktop sessions found shows message", async () => {
      const sm = createMockSessionManager([]);
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, sm, createMockInputRouter());

      const replies = await triggerCode(handlers, "scan");
      expect(sm.syncDesktopSessions).toHaveBeenCalled();
      const finalReply = replies.find((r) => r.includes("No desktop sessions found"));
      expect(finalReply).toBeDefined();
    });

    test("desktop sessions found shows count and project names", async () => {
      const desktopSession = makeSession({
        id: "desk-session-001",
        projectName: "desktop-proj",
        source: "desktop",
      });
      const sm = createMockSessionManager([desktopSession]);
      const { bot, handlers } = createMockBot();
      registerCodingCommands(bot, sm, createMockInputRouter());

      const replies = await triggerCode(handlers, "scan");
      // "Found N desktop session(s):" reply is the second one
      const countReply = replies.find((r) => r.startsWith("Found"));
      expect(countReply).toBeDefined();
      expect(countReply).toContain("desktop-proj");
    });
  });

  describe("callback_query registration", () => {
    test("registers a callback_query:data handler on the bot", () => {
      const { bot, eventHandlers } = createMockBot();
      registerCodingCommands(bot, createMockSessionManager(), createMockInputRouter());

      expect(bot.on).toHaveBeenCalledWith("callback_query:data", expect.any(Function));
    });

    test("callback handler calls next() for non-code callbacks (iq:, routine_*, unknown)", async () => {
      // Regression test: the handler must NOT swallow unrecognised callbacks.
      // Before the fix, it silently dropped iq: callbacks, preventing the
      // relay.ts iq: handler further down the middleware chain from running.
      const { bot, eventHandlers } = createMockBot();
      registerCodingCommands(bot, createMockSessionManager(), createMockInputRouter());

      const handlers = eventHandlers.get("callback_query:data") ?? [];
      expect(handlers.length).toBeGreaterThan(0);
      const handler = handlers[0];

      const nonCodingPrefixes = ["iq:a:0:0", "iq:confirm", "routine_target:dm:123", "unknown:data"];

      for (const data of nonCodingPrefixes) {
        let nextCalled = false;
        const ctx = {
          callbackQuery: { data },
          answerCallbackQuery: async () => {},
        } as any;

        await handler(ctx, async () => { nextCalled = true; });
        expect(nextCalled).toBe(true);
      }
    });

    test("callback handler does NOT call next() for code_* prefixes", async () => {
      const { bot, eventHandlers } = createMockBot();
      const inputRouter = createMockInputRouter();
      registerCodingCommands(bot, createMockSessionManager(), inputRouter);

      const handlers = eventHandlers.get("callback_query:data") ?? [];
      const handler = handlers[0];

      const codingPrefixes = ["code_answer:abc", "code_plan:xyz", "code_dash:123"];

      for (const data of codingPrefixes) {
        let nextCalled = false;
        const ctx = {
          callbackQuery: { data },
          answerCallbackQuery: async () => {},
        } as any;

        await handler(ctx, async () => { nextCalled = true; });
        expect(nextCalled).toBe(false);
      }
    });
  });
});
