/**
 * Tests: cwd propagation through NLAH harness
 *
 * Verifies that:
 * 1. plan.cwd is persisted to DispatchState.cwd
 * 2. stepPlan passed to executeSingleDispatch carries plan.cwd (via ...plan spread)
 * 3. When plan.cwd is undefined, DispatchState has no cwd field (no-op)
 */
import { describe, test, expect, mock, beforeAll } from "bun:test";
import { mkdir, writeFile, readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

const CONTRACTS_DIR = join(homedir(), ".claude-relay", "contracts");
const STATE_DIR = join(homedir(), ".claude-relay", "harness", "state");

function makeMockBot() {
  return {
    api: {
      sendMessage: async () => ({ message_id: 1 }),
    },
  };
}

function makePlan(cwd?: string): import("../../src/orchestration/types").DispatchPlan {
  return {
    dispatchId: crypto.randomUUID(),
    userMessage: "test",
    classification: {
      intent: "cwd-test-intent",
      primaryAgent: "engineering",
      topicHint: null,
      isCompound: false,
      confidence: 0.9,
      reasoning: "test",
    },
    tasks: [{ seq: 1, agentId: "engineering", topicHint: null, taskDescription: "test" }],
    cwd,
  };
}

async function readState(dispatchId: string) {
  try {
    const raw = await readFile(join(STATE_DIR, `${dispatchId}.json`), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

describe("harness cwd propagation", () => {
  beforeAll(async () => {
    await mkdir(CONTRACTS_DIR, { recursive: true });
    await mkdir(STATE_DIR, { recursive: true });
    // Use default fallback (no matching contract) so harness uses plan.classification.primaryAgent directly
  });

  test("plan.cwd is persisted to DispatchState.cwd", async () => {
    mock.module("../../src/orchestration/dispatchEngine", () => ({
      executeSingleDispatch: async () => ({ success: true, response: "ok", durationMs: 100 }),
    }));

    const { runHarness } = await import("../../src/orchestration/harness");
    const plan = makePlan("/my/project");

    await (runHarness as any)(makeMockBot(), plan, -1001, null);

    const state = await readState(plan.dispatchId);
    expect(state).not.toBeNull();
    expect(state.cwd).toBe("/my/project");
  });

  test("plan.cwd is passed through to stepPlan via spread", async () => {
    const capturedPlans: any[] = [];
    mock.module("../../src/orchestration/dispatchEngine", () => ({
      executeSingleDispatch: async (_bot: unknown, stepPlan: unknown) => {
        capturedPlans.push(stepPlan);
        return { success: true, response: "ok", durationMs: 100 };
      },
    }));

    const { runHarness } = await import("../../src/orchestration/harness");
    const plan = makePlan("/repo/worktree");

    await (runHarness as any)(makeMockBot(), plan, -1002, null);

    expect(capturedPlans).toHaveLength(1);
    expect(capturedPlans[0].cwd).toBe("/repo/worktree");
  });

  test("plan.cwd=undefined: DispatchState has no cwd field", async () => {
    mock.module("../../src/orchestration/dispatchEngine", () => ({
      executeSingleDispatch: async () => ({ success: true, response: "ok", durationMs: 100 }),
    }));

    const { runHarness } = await import("../../src/orchestration/harness");
    const plan = makePlan(undefined);

    await (runHarness as any)(makeMockBot(), plan, -1003, null);

    const state = await readState(plan.dispatchId);
    expect(state).not.toBeNull();
    expect("cwd" in state).toBe(false);
  });
});
