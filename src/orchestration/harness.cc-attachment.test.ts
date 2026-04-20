/**
 * Unit tests: CC attachment context injection in harness step loop.
 * Tests imageContext prefix and attachmentPaths persistence.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";

// ── Minimal mocks for harness dependencies ─────────────────────────────────

mock.module("../local/db.ts", () => ({
  getDb: () => ({
    query: () => ({ all: () => [] }),
    run: () => {},
  }),
}));

mock.module("../agents/config.ts", () => ({
  AGENTS: {
    "engineering": {
      id: "engineering",
      name: "Engineering",
      shortName: "Eng",
      chatId: -100001,
      topicId: null,
    },
    "research-strategy": {
      id: "research-strategy",
      name: "Research",
      shortName: "Research",
      chatId: -100002,
      topicId: null,
    },
  },
  DEFAULT_AGENT: { id: "engineering" },
}));

mock.module("fs/promises", () => ({
  mkdir: async () => {},
  writeFile: async () => {},
  readFile: async () => { throw new Error("not found"); },
}));

mock.module("os", () => ({
  homedir: () => "/tmp/test-home",
}));

// Capture what executeSingleDispatch received
let lastDispatchedDescription: string | null = null;

mock.module("./dispatchEngine.ts", () => ({
  executeSingleDispatch: async (_bot: unknown, plan: { tasks: Array<{ taskDescription: string }> }) => {
    lastDispatchedDescription = plan.tasks[0]?.taskDescription ?? null;
    return { success: true, response: "agent response", durationMs: 100 };
  },
}));

mock.module("./contractLoader.ts", () => ({
  loadContract: async () => null,
}));

mock.module("./harnessRegistry.ts", () => ({
  registerHarness: () => {},
  unregisterHarness: () => {},
  setCurrentAgentKey: () => {},
  cancelled: () => false,
}));

mock.module("../cancel.ts", () => ({
  abortStreamsForDispatch: () => {},
  streamKey: (chatId: number, topicId: number | null) => `${chatId}:${topicId}`,
}));

mock.module("../utils/htmlFormat.ts", () => ({
  markdownToHtml: (s: string) => s,
  splitMarkdown: (s: string) => [s],
  decodeHtmlEntities: (s: string) => s,
}));

mock.module("../utils/sendToGroup.ts", () => ({
  chunkMessage: (s: string) => [s],
}));

mock.module("./pendingAgentReplies.ts", () => ({
  trackAgentReply: () => {},
  trackLastActiveAgent: () => {},
}));

const mockBot = {
  api: {
    sendMessage: async () => ({ message_id: 1 }),
  },
};

// ── Import AFTER mocks ──────────────────────────────────────────────────────

const { runHarness } = await import("./harness.ts");
import type { DispatchPlan } from "./types.ts";

// ── Tests ───────────────────────────────────────────────────────────────────

describe("harness — CC attachment context", () => {
  beforeEach(() => {
    lastDispatchedDescription = null;
  });

  const basePlan: DispatchPlan = {
    dispatchId: "test-dispatch-1",
    userMessage: "review this architecture",
    classification: {
      intent: "code-review",
      primaryAgent: "engineering",
      topicHint: null,
      isCompound: false,
      confidence: 0.95,
      reasoning: "looks like code",
    },
    tasks: [{ seq: 1, agentId: "engineering", topicHint: null, taskDescription: "review this architecture" }],
  };

  it("injects imageContext prefix into taskDescription when present", async () => {
    const plan: DispatchPlan = {
      ...basePlan,
      dispatchId: "test-dispatch-img-1",
      imageContext: "The image shows a microservices diagram with 3 services.",
      attachmentPaths: ["/tmp/test-home/.claude-relay/attachments/abc/photo_0.jpg"],
    };

    await runHarness(mockBot as never, plan, -100999, null);

    expect(lastDispatchedDescription).toBeTruthy();
    expect(lastDispatchedDescription).toContain("Attachment context — images analyzed at dispatch time:");
    expect(lastDispatchedDescription).toContain("The image shows a microservices diagram with 3 services.");
    expect(lastDispatchedDescription).toContain("review this architecture");
  });

  it("does NOT inject imageContext prefix when absent", async () => {
    const plan: DispatchPlan = {
      ...basePlan,
      dispatchId: "test-dispatch-noimg-1",
    };

    await runHarness(mockBot as never, plan, -100999, null);

    expect(lastDispatchedDescription).toBe("review this architecture");
    expect(lastDispatchedDescription).not.toContain("Attachment context");
  });

  it("persists attachmentPaths in state JSON when present", async () => {
    const writtenFiles: Record<string, string> = {};

    // Override writeFile to capture state JSON
    mock.module("fs/promises", () => ({
      mkdir: async () => {},
      writeFile: async (path: string, content: string) => {
        writtenFiles[path] = content;
      },
      readFile: async () => { throw new Error("not found"); },
    }));

    const { runHarness: runHarness2 } = await import("./harness.ts?v=2");

    const plan: DispatchPlan = {
      ...basePlan,
      dispatchId: "test-dispatch-persist-1",
      imageContext: "test image context",
      attachmentPaths: ["/tmp/test-home/.claude-relay/attachments/xyz/photo_0.jpg"],
    };

    await runHarness2(mockBot as never, plan, -100999, null);

    const stateFile = Object.keys(writtenFiles).find((k) => k.includes("test-dispatch-persist-1.json"));
    expect(stateFile).toBeTruthy();
    if (stateFile) {
      const state = JSON.parse(writtenFiles[stateFile]);
      expect(state.attachmentPaths).toEqual(["/tmp/test-home/.claude-relay/attachments/xyz/photo_0.jpg"]);
    }
  });

  it("does NOT include attachmentPaths in state when not provided", async () => {
    const writtenFiles: Record<string, string> = {};

    mock.module("fs/promises", () => ({
      mkdir: async () => {},
      writeFile: async (path: string, content: string) => {
        writtenFiles[path] = content;
      },
      readFile: async () => { throw new Error("not found"); },
    }));

    const { runHarness: runHarness3 } = await import("./harness.ts?v=3");

    const plan: DispatchPlan = {
      ...basePlan,
      dispatchId: "test-dispatch-nopaths-1",
    };

    await runHarness3(mockBot as never, plan, -100999, null);

    const stateFile = Object.keys(writtenFiles).find((k) => k.includes("test-dispatch-nopaths-1.json"));
    expect(stateFile).toBeTruthy();
    if (stateFile) {
      const state = JSON.parse(writtenFiles[stateFile]);
      expect(state.attachmentPaths).toBeUndefined();
    }
  });
});

describe("dispatchEngine — dangerouslySkipPermissions forwarding", () => {
  it("DispatchRunnerOpts type includes dangerouslySkipPermissions", async () => {
    const { } = await import("./dispatchEngine.ts");
    // Type-level check — TypeScript would fail compilation if the field doesn't exist
    const opts: import("./dispatchEngine.ts").DispatchRunnerOpts = { dangerouslySkipPermissions: true };
    expect(opts.dangerouslySkipPermissions).toBe(true);
  });
});
