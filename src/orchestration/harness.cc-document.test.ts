/**
 * Unit tests: CC document attachment context injection in harness step loop.
 * Companion to harness.cc-attachment.test.ts (which covers imageContext).
 *
 * Verifies:
 *   - documentContext prefix present when set
 *   - documentContext prefix absent when unset
 *   - imageContext AND documentContext both present → both prefixes injected, order stable
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

const { runHarness } = await import("./harness.ts");
import type { DispatchPlan } from "./types.ts";

describe("harness — CC document attachment context", () => {
  beforeEach(() => {
    lastDispatchedDescription = null;
  });

  const basePlan: DispatchPlan = {
    dispatchId: "test-dispatch-docs-base",
    userMessage: "summarise this report",
    classification: {
      intent: "research",
      primaryAgent: "engineering",
      topicHint: null,
      isCompound: false,
      confidence: 0.95,
      reasoning: "needs document review",
    },
    tasks: [{ seq: 1, agentId: "engineering", topicHint: null, taskDescription: "summarise this report" }],
  };

  it("injects documentContext prefix into taskDescription when present", async () => {
    const plan: DispatchPlan = {
      ...basePlan,
      dispatchId: "test-dispatch-doc-1",
      documentContext: "- report.pdf (application/pdf, 1.2 MB) → /tmp/test-home/.claude-relay/attachments/xyz/report.pdf",
      attachmentPaths: ["/tmp/test-home/.claude-relay/attachments/xyz/report.pdf"],
    };

    await runHarness(mockBot as never, plan, -100999, null);

    expect(lastDispatchedDescription).toBeTruthy();
    expect(lastDispatchedDescription).toContain("Attachment context — documents available at dispatch time:");
    expect(lastDispatchedDescription).toContain("report.pdf");
    expect(lastDispatchedDescription).toContain("/tmp/test-home/.claude-relay/attachments/xyz/report.pdf");
    expect(lastDispatchedDescription).toContain("summarise this report");
  });

  it("does NOT inject documentContext prefix when absent", async () => {
    const plan: DispatchPlan = {
      ...basePlan,
      dispatchId: "test-dispatch-nodoc-1",
    };

    await runHarness(mockBot as never, plan, -100999, null);

    expect(lastDispatchedDescription).toBeTruthy();
    expect(lastDispatchedDescription).not.toContain("Attachment context — documents available");
    expect(lastDispatchedDescription).not.toContain("Attachment context — images");
  });

  it("injects BOTH image and document prefixes in stable order (image before document)", async () => {
    const plan: DispatchPlan = {
      ...basePlan,
      dispatchId: "test-dispatch-both-1",
      imageContext: "Screenshot shows an AWS diagram.",
      documentContext: "- spec.pdf → /tmp/test-home/.claude-relay/attachments/k/spec.pdf",
      attachmentPaths: [
        "/tmp/test-home/.claude-relay/attachments/k/photo_0.jpg",
        "/tmp/test-home/.claude-relay/attachments/k/spec.pdf",
      ],
    };

    await runHarness(mockBot as never, plan, -100999, null);

    expect(lastDispatchedDescription).toBeTruthy();
    const imgIdx = lastDispatchedDescription!.indexOf("images analyzed at dispatch time");
    const docIdx = lastDispatchedDescription!.indexOf("documents available at dispatch time");
    expect(imgIdx).toBeGreaterThan(-1);
    expect(docIdx).toBeGreaterThan(-1);
    expect(imgIdx).toBeLessThan(docIdx); // stable: images first, then documents
  });
});
