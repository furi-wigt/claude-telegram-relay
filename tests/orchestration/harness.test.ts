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

const LOOP_CONTRACT = `---
intent: code-review-loop
agents: [engineering, code-quality-coach]
max_loop_iterations: 2
---
# Code Review with Loop

## Steps
1. **engineering** — implement the feature
2. **code-quality-coach** — review; emit [LOOP: engineering] if issues found
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
    await writeFile(join(CONTRACTS_DIR, "code-review-loop-test.md"), LOOP_CONTRACT);
  });

  afterAll(async () => {
    for (const f of ["code-review-test.md", "security-audit-test.md", "code-review-loop-test.md"]) {
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
    // 5 agents: 3 redirects allowed (ops→eng→research-strategy→cloud), 4th redirect (cloud→security) blocked
    const agents = ["operations-hub", "engineering", "research-strategy", "cloud-architect", "security-compliance"];
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

  // ── HarnessResult return type tests ──────────────────────────────────────────

  test("return type: single-step success returns { outcome: 'done' }", async () => {
    mock.module("../../src/orchestration/dispatchEngine", () => ({
      executeSingleDispatch: async () => ({ success: true, response: "Done!", durationMs: 100 }),
    }));

    const { runHarness } = await import("../../src/orchestration/harness");
    const bot = makeMockBot() as any;
    const plan = makePlan("general", "engineering");

    const result = await runHarness(bot, plan, -200001, null);
    expect(result.outcome).toBe("done");
  });

  test("return type: step failure returns { outcome: 'failed' }", async () => {
    mock.module("../../src/orchestration/dispatchEngine", () => ({
      executeSingleDispatch: async () => ({ success: false, response: "Timed out", durationMs: 300000 }),
    }));

    const { runHarness } = await import("../../src/orchestration/harness");
    const bot = makeMockBot() as any;
    const plan = makePlan("general", "engineering");

    const result = await runHarness(bot, plan, -200002, null);
    expect(result.outcome).toBe("failed");
  });

  // ── [CLARIFY:] tag tests ──────────────────────────────────────────────────────

  test("clarify: [CLARIFY: question] → outcome suspended, question extracted, state suspended", async () => {
    mock.module("../../src/orchestration/dispatchEngine", () => ({
      executeSingleDispatch: async () => ({
        success: true,
        response: "I need more info. [CLARIFY: Which auth method — JWT or session?]",
        durationMs: 400,
      }),
    }));

    const { runHarness } = await import("../../src/orchestration/harness");
    const bot = makeMockBot() as any;
    const plan = makePlan("general", "engineering");

    const result = await runHarness(bot, plan, -200010, null);

    expect(result.outcome).toBe("suspended");
    if (result.outcome === "suspended") {
      expect(result.question).toBe("Which auth method — JWT or session?");
      expect(result.agentId).toBe("engineering");
    }

    const state = await readState(plan.dispatchId);
    expect(state.status).toBe("suspended");
    expect(state.pendingQuestion).toBe("Which auth method — JWT or session?");
    expect(state.pendingAgent).toBe("engineering");
    // Tag stripped from stored output
    expect(state.steps[0].output).not.toContain("[CLARIFY:");
    // Step status is "suspended"
    expect(state.steps[0].status).toBe("suspended");

    // Question posted to CC
    const clarifyMsg = bot._sent.find((m: any) => m.text?.includes("needs clarification"));
    expect(clarifyMsg).not.toBeUndefined();
  });

  test("clarify: [CLARIFY:] wins over [REDIRECT:] when both present", async () => {
    const dispatched: string[] = [];
    mock.module("../../src/orchestration/dispatchEngine", () => ({
      executeSingleDispatch: async (_bot: unknown, plan: any) => {
        dispatched.push(plan.classification.primaryAgent);
        return {
          success: true,
          response: "Need input. [CLARIFY: What exactly?] [REDIRECT: engineering]",
          durationMs: 300,
        };
      },
    }));

    const { runHarness } = await import("../../src/orchestration/harness");
    const bot = makeMockBot() as any;
    const plan = makePlan("general", "operations-hub");

    const result = await runHarness(bot, plan, -200011, null);

    // Should suspend, NOT redirect
    expect(result.outcome).toBe("suspended");
    // Only one dispatch — redirect not followed
    expect(dispatched).toHaveLength(1);
  });

  // ── resumeFrom tests ──────────────────────────────────────────────────────────

  test("resumeFrom: skips done steps, runs suspended/pending step", async () => {
    const dispatched: string[] = [];
    mock.module("../../src/orchestration/dispatchEngine", () => ({
      executeSingleDispatch: async (_bot: unknown, plan: any) => {
        dispatched.push(plan.classification.primaryAgent);
        return { success: true, response: "Done on resume.", durationMs: 200 };
      },
    }));

    const { runHarness } = await import("../../src/orchestration/harness");
    const bot = makeMockBot() as any;

    // Build an existing state: step 1 done, step 2 suspended
    const existingState = {
      dispatchId: crypto.randomUUID(),
      userMessage: "original",
      contractFile: null,
      steps: [
        { seq: 1, agent: "operations-hub", status: "done", output: "first done", durationMs: 100 },
        { seq: 2, agent: "engineering", status: "suspended", output: "need info", durationMs: 200 },
      ],
      status: "suspended",
      pendingQuestion: "Which method?",
      pendingAgent: "engineering",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any;

    const plan = {
      ...makePlan("general", "engineering"),
      dispatchId: existingState.dispatchId,
      userMessage: "original + clarification: JWT",
    };

    const result = await runHarness(bot, plan, -200020, null, { resumeFrom: existingState });

    // Only engineering dispatched (ops-hub was already done)
    expect(dispatched).toEqual(["engineering"]);
    expect(result.outcome).toBe("done");

    const state = await readState(existingState.dispatchId);
    expect(state.status).toBe("done");
  });

  // ── Cancellation tests (Phase 2b) ───────────────────────────────────────────

  describe("cancellation", () => {
    test("cancel between steps: step 2 is skipped, status=cancelled", async () => {
      let callCount = 0;
      const { requestCancel, _resetRegistryForTests } = await import("../../src/orchestration/harnessRegistry");
      _resetRegistryForTests();

      mock.module("../../src/orchestration/dispatchEngine", () => ({
        executeSingleDispatch: async (_bot: unknown, plan: any) => {
          callCount++;
          // Cancel the dispatch right after step 1 completes
          if (callCount === 1) {
            requestCancel(plan.dispatchId);
          }
          return { success: true, response: `step ${callCount}`, durationMs: 100 };
        },
      }));

      const { runHarness } = await import("../../src/orchestration/harness");
      const bot = makeMockBot() as any;
      const plan = makePlan("security-audit-test", "security-compliance");

      const result = await runHarness(bot, plan, -100901, null);

      // Step 1 ran; step 2 must NOT have run
      expect(callCount).toBe(1);
      expect(result.outcome).toBe("cancelled");

      const state = await readState(plan.dispatchId);
      expect(state.status).toBe("cancelled");
      expect(state.steps[0].status).toBe("done");
      expect(state.steps[1].status).toBe("pending"); // never started
    });

    test("cancel before any step runs: status=cancelled, no dispatch calls", async () => {
      let callCount = 0;
      const { registerHarness, requestCancel, _resetRegistryForTests } =
        await import("../../src/orchestration/harnessRegistry");
      _resetRegistryForTests();

      mock.module("../../src/orchestration/dispatchEngine", () => ({
        executeSingleDispatch: async () => {
          callCount++;
          return { success: true, response: "should not run", durationMs: 50 };
        },
      }));

      const { runHarness } = await import("../../src/orchestration/harness");
      const bot = makeMockBot() as any;
      const plan = makePlan("security-audit-test", "security-compliance");

      // Pre-register and cancel BEFORE runHarness starts. runHarness's
      // idempotent registerHarness must NOT clear the cancelled flag.
      registerHarness(plan.dispatchId, { ccChatId: -100902, ccThreadId: null });
      requestCancel(plan.dispatchId);

      const result = await runHarness(bot, plan, -100902, null);

      expect(callCount).toBe(0);
      expect(result.outcome).toBe("cancelled");

      const state = await readState(plan.dispatchId);
      expect(state.status).toBe("cancelled");
    });

    test("idempotent cancel: double requestCancel does not throw", async () => {
      const { requestCancel, _resetRegistryForTests } =
        await import("../../src/orchestration/harnessRegistry");
      _resetRegistryForTests();

      mock.module("../../src/orchestration/dispatchEngine", () => ({
        executeSingleDispatch: async (_bot: unknown, plan: any) => {
          requestCancel(plan.dispatchId);
          requestCancel(plan.dispatchId); // double cancel
          return { success: true, response: "step", durationMs: 50 };
        },
      }));

      const { runHarness } = await import("../../src/orchestration/harness");
      const bot = makeMockBot() as any;
      const plan = makePlan("security-audit-test", "security-compliance");

      const result = await runHarness(bot, plan, -100903, null);
      expect(result.outcome).toBe("cancelled");
    });

    test("registry is unregistered after harness completes (finally path)", async () => {
      const { lookupByCcChat, _resetRegistryForTests } =
        await import("../../src/orchestration/harnessRegistry");
      _resetRegistryForTests();

      mock.module("../../src/orchestration/dispatchEngine", () => ({
        executeSingleDispatch: async () => ({ success: true, response: "ok", durationMs: 50 }),
      }));

      const { runHarness } = await import("../../src/orchestration/harness");
      const bot = makeMockBot() as any;
      const plan = makePlan("code-review-test");

      await runHarness(bot, plan, -100904, null);

      // After completion, no harness should be registered for this CC chat
      expect(lookupByCcChat(-100904, null)).toBeNull();
    });

    test("registry is unregistered after harness throws (finally path)", async () => {
      const { lookupByCcChat, _resetRegistryForTests } =
        await import("../../src/orchestration/harnessRegistry");
      _resetRegistryForTests();

      mock.module("../../src/orchestration/dispatchEngine", () => ({
        executeSingleDispatch: async () => {
          throw new Error("simulated dispatch failure");
        },
      }));

      const { runHarness } = await import("../../src/orchestration/harness");
      const bot = makeMockBot() as any;
      const plan = makePlan("code-review-test");

      await runHarness(bot, plan, -100905, null).catch(() => {
        /* swallow — we're testing the finally cleanup, not the error path */
      });

      expect(lookupByCcChat(-100905, null)).toBeNull();
    });

    test("mid-step: setCurrentAgentKey is set before each dispatch (mid-stream abort target)", async () => {
      const { currentAgentKey, _resetRegistryForTests } =
        await import("../../src/orchestration/harnessRegistry");
      _resetRegistryForTests();

      const observedKeys: Array<string | null> = [];

      mock.module("../../src/orchestration/dispatchEngine", () => ({
        executeSingleDispatch: async (_bot: unknown, plan: any) => {
          // At this point harness must have set currentAgentKey for this step
          observedKeys.push(currentAgentKey(plan.dispatchId));
          return { success: true, response: "ok", durationMs: 50 };
        },
      }));

      const { runHarness } = await import("../../src/orchestration/harness");
      const bot = makeMockBot() as any;
      const plan = makePlan("security-audit-test", "security-compliance");

      await runHarness(bot, plan, -100906, null);

      expect(observedKeys).toHaveLength(2);
      expect(observedKeys[0]).not.toBeNull();
      expect(observedKeys[1]).not.toBeNull();
      // Keys are stream-key shaped: "${chatId}:${threadId ?? ''}"
      expect(observedKeys[0]).toMatch(/^-?\d+:/);
    });

    test("mid-stream cancel: abortStreamsForDispatch removes streams tagged with dispatchId", async () => {
      const { requestCancel, _resetRegistryForTests } =
        await import("../../src/orchestration/harnessRegistry");
      const { activeStreams } = await import("../../src/cancel");
      _resetRegistryForTests();
      activeStreams.clear();

      mock.module("../../src/orchestration/dispatchEngine", () => ({
        executeSingleDispatch: async (_bot: unknown, plan: any) => {
          // Pre-seed an in-flight stream tagged with this dispatchId, then
          // simulate user clicking Cancel WHILE the stream is in flight.
          const controller = new AbortController();
          activeStreams.set(`-100907:`, {
            controller,
            dispatchId: plan.dispatchId,
          });
          requestCancel(plan.dispatchId);
          return { success: true, response: "partial", durationMs: 100 };
        },
      }));

      const { runHarness } = await import("../../src/orchestration/harness");
      const bot = makeMockBot() as any;
      const plan = makePlan("security-audit-test", "security-compliance");

      await runHarness(bot, plan, -100907, null);

      // Harness must have aborted the tagged stream — entry removed from map.
      expect(activeStreams.has(`-100907:`)).toBe(false);
    });
  });

  // ── Loop pattern tests ────────────────────────────────────────────────────────

  describe("loop pattern", () => {
    test("loop: QA passes on first try → done, no loop steps appended", async () => {
      const dispatched: string[] = [];
      mock.module("../../src/orchestration/dispatchEngine", () => ({
        executeSingleDispatch: async (_bot: unknown, plan: any) => {
          dispatched.push(plan.classification.primaryAgent);
          return { success: true, response: "LGTM.", durationMs: 300 };
        },
      }));

      const { runHarness } = await import("../../src/orchestration/harness");
      const bot = makeMockBot() as any;
      const plan = makePlan("code-review-loop-test", "engineering");

      const result = await runHarness(bot, plan, -300001, null);

      expect(result.outcome).toBe("done");
      expect(dispatched).toEqual(["engineering", "code-quality-coach"]);
      const state = await readState(plan.dispatchId);
      expect(state.status).toBe("done");
      expect(state.steps).toHaveLength(2);
    });

    test("loop: QA fails once, engineer re-runs, QA passes → done (4 steps total)", async () => {
      let callCount = 0;
      const dispatched: string[] = [];
      mock.module("../../src/orchestration/dispatchEngine", () => ({
        executeSingleDispatch: async (_bot: unknown, plan: any) => {
          callCount++;
          const agentId = plan.classification.primaryAgent;
          dispatched.push(agentId);
          if (agentId === "code-quality-coach" && callCount === 2) {
            return { success: true, response: "Needs fixes. [LOOP: engineering]", durationMs: 400 };
          }
          return { success: true, response: "Done.", durationMs: 300 };
        },
      }));

      const { runHarness } = await import("../../src/orchestration/harness");
      const bot = makeMockBot() as any;
      const plan = makePlan("code-review-loop-test", "engineering");

      const result = await runHarness(bot, plan, -300002, null);

      expect(result.outcome).toBe("done");
      expect(dispatched).toEqual(["engineering", "code-quality-coach", "engineering", "code-quality-coach"]);
      expect(callCount).toBe(4);
      const state = await readState(plan.dispatchId);
      expect(state.status).toBe("done");
      expect(state.steps).toHaveLength(4);

      const qaStepWithTag = state.steps.find((s: any) => s.output?.includes("[LOOP:"));
      expect(qaStepWithTag).toBeUndefined();

      const loopMsg = bot._sent.find((m: any) =>
        typeof m.text === "string" && m.text.includes("iteration 1/2")
      );
      expect(loopMsg).not.toBeUndefined();
    });

    test("loop: max iterations (2) exceeded → state=failed", async () => {
      mock.module("../../src/orchestration/dispatchEngine", () => ({
        executeSingleDispatch: async (_bot: unknown, plan: any) => {
          if (plan.classification.primaryAgent === "code-quality-coach") {
            return { success: true, response: "Still broken. [LOOP: engineering]", durationMs: 400 };
          }
          return { success: true, response: "Implemented.", durationMs: 300 };
        },
      }));

      const { runHarness } = await import("../../src/orchestration/harness");
      const bot = makeMockBot() as any;
      const plan = makePlan("code-review-loop-test", "engineering");

      const result = await runHarness(bot, plan, -300003, null);

      expect(result.outcome).toBe("failed");
      if (result.outcome === "failed") {
        expect(result.error).toBe("max loop iterations reached");
      }
      const state = await readState(plan.dispatchId);
      expect(state.status).toBe("failed");

      const warnMsg = bot._sent.find((m: any) =>
        typeof m.text === "string" && m.text.toLowerCase().includes("max loop")
      );
      expect(warnMsg).not.toBeUndefined();
    });

    test("loop: [LOOP:] wins over [REDIRECT:] when both present", async () => {
      const dispatched: string[] = [];
      mock.module("../../src/orchestration/dispatchEngine", () => ({
        executeSingleDispatch: async (_bot: unknown, plan: any) => {
          dispatched.push(plan.classification.primaryAgent);
          if (plan.classification.primaryAgent === "code-quality-coach") {
            return {
              success: true,
              response: "Needs work. [LOOP: engineering] [REDIRECT: cloud-architect]",
              durationMs: 400,
            };
          }
          return { success: true, response: "Done.", durationMs: 300 };
        },
      }));

      const { runHarness } = await import("../../src/orchestration/harness");
      const bot = makeMockBot() as any;
      const plan = makePlan("code-review-loop-test", "engineering");

      await runHarness(bot, plan, -300004, null);

      expect(dispatched).not.toContain("cloud-architect");
      expect(dispatched).toContain("code-quality-coach");
    });

    test("loop: unknown agent-id in [LOOP:] tag is ignored, dispatch completes normally", async () => {
      const dispatched: string[] = [];
      mock.module("../../src/orchestration/dispatchEngine", () => ({
        executeSingleDispatch: async (_bot: unknown, plan: any) => {
          dispatched.push(plan.classification.primaryAgent);
          if (plan.classification.primaryAgent === "code-quality-coach") {
            return { success: true, response: "Oops. [LOOP: nonexistent-agent]", durationMs: 300 };
          }
          return { success: true, response: "Done.", durationMs: 200 };
        },
      }));

      const { runHarness } = await import("../../src/orchestration/harness");
      const bot = makeMockBot() as any;
      const plan = makePlan("code-review-loop-test", "engineering");

      const result = await runHarness(bot, plan, -300005, null);

      expect(result.outcome).toBe("done");
      expect(dispatched).toEqual(["engineering", "code-quality-coach"]);
    });
  });
});
