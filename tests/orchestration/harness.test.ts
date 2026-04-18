import { describe, test, expect, mock, beforeAll, afterAll } from "bun:test";
import { mkdir, writeFile, rm, readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

const CONTRACTS_DIR = join(homedir(), ".claude-relay", "contracts");
const STATE_DIR = join(homedir(), ".claude-relay", "harness", "state");

// ── Contract fixtures ─────────────────────────────────────────────────────────

const SINGLE_STEP_CONTRACT = `---
intent: code-review
agents: [engineering]
---
# Code Review

## Steps
1. **engineering** — review code
`;

const TWO_STEP_CONTRACT = `---
intent: security-audit
agents: [security-compliance, engineering]
---
# Security Audit

## Steps
1. **security-compliance** — threat model
2. **engineering** — code scan
`;

// ── Mocks ─────────────────────────────────────────────────────────────────────

/** Minimal mock bot that captures sendMessage calls */
function makeMockBot() {
  const sent: Array<{ chatId: number; text: string; opts?: unknown }> = [];
  const bot = {
    api: {
      sendMessage: async (chatId: number, text: string, opts?: unknown) => {
        sent.push({ chatId, text, opts });
        return { message_id: Math.floor(Math.random() * 1000) };
      },
    },
    _sent: sent,
  };
  return bot;
}

/** Mock DispatchPlan */
function makePlan(intent: string, agentId = "engineering"): import("../../src/orchestration/types").DispatchPlan {
  return {
    dispatchId: crypto.randomUUID(),
    userMessage: "test message",
    classification: {
      intent,
      primaryAgent: agentId,
      topicHint: null,
      isCompound: false,
      confidence: 0.9,
      reasoning: "test",
    },
    tasks: [{ seq: 1, agentId, topicHint: null, taskDescription: "test message" }],
  };
}

// ── Test helpers ──────────────────────────────────────────────────────────────

async function readState(dispatchId: string) {
  try {
    const raw = await readFile(join(STATE_DIR, `${dispatchId}.json`), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("harness", () => {
  beforeAll(async () => {
    await mkdir(CONTRACTS_DIR, { recursive: true });
    await mkdir(STATE_DIR, { recursive: true });
    await writeFile(join(CONTRACTS_DIR, "code-review-test.md"), SINGLE_STEP_CONTRACT);
    await writeFile(join(CONTRACTS_DIR, "security-audit-test.md"), TWO_STEP_CONTRACT);
  });

  afterAll(async () => {
    for (const f of ["code-review-test.md", "security-audit-test.md"]) {
      await rm(join(CONTRACTS_DIR, f), { force: true });
    }
  });

  test("single-step: dispatches once, posts result, state=done", async () => {
    mock.module("../../src/orchestration/dispatchEngine", () => ({
      executeSingleDispatch: async () => ({
        success: true,
        response: "LGTM",
        durationMs: 1200,
      }),
    }));

    const { runHarness } = await import("../../src/orchestration/harness");
    const bot = makeMockBot() as any;
    const plan = makePlan("code-review-test");

    await runHarness(bot, plan, -100123, null);

    const state = await readState(plan.dispatchId);
    expect(state).not.toBeNull();
    expect(state.status).toBe("done");
    expect(state.steps).toHaveLength(1);
    expect(state.steps[0].status).toBe("done");
    // No synthesis message for single-step
    const synthMsg = bot._sent.find((m: any) => m.text.includes("Dispatch complete"));
    expect(synthMsg).toBeUndefined();
  });

  test("multi-step: dispatches sequentially, posts per-step + synthesis", async () => {
    let callCount = 0;
    mock.module("../../src/orchestration/dispatchEngine", () => ({
      executeSingleDispatch: async (_bot: unknown, plan: any) => {
        callCount++;
        return { success: true, response: `response from ${plan.classification.primaryAgent}`, durationMs: 500 };
      },
    }));

    const { runHarness } = await import("../../src/orchestration/harness");
    const bot = makeMockBot() as any;
    const plan = makePlan("security-audit-test", "security-compliance");

    await runHarness(bot, plan, -100456, null);

    expect(callCount).toBe(2);
    const state = await readState(plan.dispatchId);
    expect(state.status).toBe("done");
    expect(state.steps).toHaveLength(2);

    const synthMsg = bot._sent.find((m: any) => m.text.includes("Dispatch complete"));
    expect(synthMsg).not.toBeUndefined();
  });

  test("step failure: stops chain, state=failed", async () => {
    let callCount = 0;
    mock.module("../../src/orchestration/dispatchEngine", () => ({
      executeSingleDispatch: async () => {
        callCount++;
        return { success: false, response: "Agent timed out", durationMs: 300000 };
      },
    }));

    const { runHarness } = await import("../../src/orchestration/harness");
    const bot = makeMockBot() as any;
    const plan = makePlan("security-audit-test");

    await runHarness(bot, plan, -100789, null);

    expect(callCount).toBe(1); // stopped after first failure
    const state = await readState(plan.dispatchId);
    expect(state.status).toBe("failed");
    expect(state.steps[0].status).toBe("failed");
  });

  // ── Redirect routing tests ──────────────────────────────────────────────────

  test("redirect: ops-hub returns [REDIRECT: engineering], harness dispatches to engineering", async () => {
    const dispatched: string[] = [];
    mock.module("../../src/orchestration/dispatchEngine", () => ({
      executeSingleDispatch: async (_bot: unknown, plan: any) => {
        const agentId = plan.classification.primaryAgent;
        dispatched.push(agentId);
        if (agentId === "operations-hub") {
          return { success: true, response: "This needs code review. [REDIRECT: engineering]", durationMs: 300 };
        }
        return { success: true, response: "Code review done.", durationMs: 500 };
      },
    }));

    const { runHarness } = await import("../../src/orchestration/harness");
    const bot = makeMockBot() as any;
    const plan = makePlan("general", "operations-hub");

    await runHarness(bot, plan, -100111, null);

    // Both agents called
    expect(dispatched).toEqual(["operations-hub", "engineering"]);
    const state = await readState(plan.dispatchId);
    expect(state.status).toBe("done");
    expect(state.steps).toHaveLength(2);
    // Redirect tag stripped from stored output
    expect(state.steps[0].output).not.toContain("[REDIRECT:");
    // CC notification posted
    const redirectMsg = bot._sent.find((m: any) => m.text.includes("redirected"));
    expect(redirectMsg).not.toBeUndefined();
  });

  test("redirect: tag is case-insensitive [REDIRECT: ENGINEERING]", async () => {
    const dispatched: string[] = [];
    mock.module("../../src/orchestration/dispatchEngine", () => ({
      executeSingleDispatch: async (_bot: unknown, plan: any) => {
        const agentId = plan.classification.primaryAgent;
        dispatched.push(agentId);
        if (agentId === "operations-hub") {
          return { success: true, response: "Needs code work. [REDIRECT: ENGINEERING]", durationMs: 200 };
        }
        return { success: true, response: "Done.", durationMs: 400 };
      },
    }));

    const { runHarness } = await import("../../src/orchestration/harness");
    const bot = makeMockBot() as any;
    const plan = makePlan("general", "operations-hub");

    await runHarness(bot, plan, -100222, null);

    expect(dispatched).toContain("engineering");
    const state = await readState(plan.dispatchId);
    expect(state.status).toBe("done");
  });

  test("redirect: unknown agent-id in tag is ignored, step treated as done", async () => {
    const dispatched: string[] = [];
    mock.module("../../src/orchestration/dispatchEngine", () => ({
      executeSingleDispatch: async (_bot: unknown, plan: any) => {
        dispatched.push(plan.classification.primaryAgent);
        return { success: true, response: "Done. [REDIRECT: nonexistent-agent]", durationMs: 200 };
      },
    }));

    const { runHarness } = await import("../../src/orchestration/harness");
    const bot = makeMockBot() as any;
    const plan = makePlan("general", "operations-hub");

    await runHarness(bot, plan, -100333, null);

    // Only one dispatch — unknown agent ignored
    expect(dispatched).toHaveLength(1);
    const state = await readState(plan.dispatchId);
    expect(state.status).toBe("done");
  });

  test("redirect: circular redirect (A→B→A) is detected, state=failed", async () => {
    const dispatched: string[] = [];
    mock.module("../../src/orchestration/dispatchEngine", () => ({
      executeSingleDispatch: async (_bot: unknown, plan: any) => {
        const agentId = plan.classification.primaryAgent;
        dispatched.push(agentId);
        if (agentId === "operations-hub") {
          return { success: true, response: "Not my domain. [REDIRECT: engineering]", durationMs: 200 };
        }
        // engineering tries to redirect back to ops — circular
        return { success: true, response: "Actually ops should handle this. [REDIRECT: operations-hub]", durationMs: 200 };
      },
    }));

    const { runHarness } = await import("../../src/orchestration/harness");
    const bot = makeMockBot() as any;
    const plan = makePlan("general", "operations-hub");

    await runHarness(bot, plan, -100444, null);

    // Exactly 2 dispatches: ops → engineering → circular detected
    expect(dispatched).toEqual(["operations-hub", "engineering"]);
    const state = await readState(plan.dispatchId);
    expect(state.status).toBe("failed");
    const warnMsg = bot._sent.find((m: any) =>
      typeof m.text === "string" && m.text.toLowerCase().includes("circular")
    );
    expect(warnMsg).not.toBeUndefined();
  });

  test("redirect: hop limit (3) reached, state=failed", async () => {
    let hop = 0;
    // 5 agents: 3 redirects allowed (ops→eng→strategy→cloud), 4th redirect (cloud→security) blocked
    const agents = ["operations-hub", "engineering", "strategy-comms", "cloud-architect", "security-compliance"];
    mock.module("../../src/orchestration/dispatchEngine", () => ({
      executeSingleDispatch: async (_bot: unknown, plan: any) => {
        const next = agents[hop + 1] ?? null;
        hop++;
        const redirectTag = next ? ` [REDIRECT: ${next}]` : "";
        return { success: true, response: `Hop ${hop}.${redirectTag}`, durationMs: 100 };
      },
    }));

    const { runHarness } = await import("../../src/orchestration/harness");
    const bot = makeMockBot() as any;
    const plan = makePlan("general", "operations-hub");

    await runHarness(bot, plan, -100555, null);

    // MAX_REDIRECT_HOPS=3 allows 3 redirects → 4 dispatches (ops+eng+strategy+cloud)
    // cloud tries to redirect to security-compliance → blocked at hop limit
    expect(hop).toBe(4);
    const state = await readState(plan.dispatchId);
    expect(state.status).toBe("failed");
    const limitMsg = bot._sent.find((m: any) =>
      typeof m.text === "string" && m.text.toLowerCase().includes("max")
    );
    expect(limitMsg).not.toBeUndefined();
  });
});
