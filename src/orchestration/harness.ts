/**
 * NLAH Harness — Thin Event Loop
 *
 * Loads a contract, executes steps sequentially, writes a state file,
 * and posts each step's result to the CC thread.
 *
 * Redirect routing: agents may include [REDIRECT: <agent-id>] in their response
 * to signal the harness to re-route the original request to a different agent.
 *
 * Clarify routing: agents may include [CLARIFY: <question>] to pause the job
 * and wait for user clarification before proceeding.
 *
 * Loop guard: max 3 redirect hops; circular redirects are detected and aborted.
 */

import type { Bot } from "grammy";
import { mkdir, writeFile, readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { loadContract } from "./contractLoader.ts";
import { executeSingleDispatch } from "./dispatchEngine.ts";
import { markdownToHtml, splitMarkdown, decodeHtmlEntities } from "../utils/htmlFormat.ts";
import { chunkMessage } from "../utils/sendToGroup.ts";
import type { DispatchPlan } from "./types.ts";
import { AGENTS } from "../agents/config.ts";
import { trackAgentReply, trackLastActiveAgent } from "./pendingAgentReplies.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export type StepStatus = "pending" | "in_progress" | "done" | "failed" | "suspended";
export type HarnessStatus = "in_progress" | "done" | "failed" | "cancelled" | "suspended";

export interface StepState {
  seq: number;
  agent: string;
  status: StepStatus;
  output: string | null;
  durationMs: number | null;
}

export interface DispatchState {
  dispatchId: string;
  userMessage: string;
  contractFile: string | null;
  steps: StepState[];
  status: HarnessStatus;
  /** Populated when status === "suspended" — the question the agent asked */
  pendingQuestion?: string;
  /** Populated when status === "suspended" — which agent asked */
  pendingAgent?: string;
  createdAt: string;
  updatedAt: string;
}

export type HarnessResult =
  | { outcome: "done" }
  | { outcome: "failed"; error?: string }
  | { outcome: "suspended"; question: string; agentId: string };

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_REDIRECT_HOPS = 3;
const REDIRECT_TAG_RE = /\[REDIRECT:\s*([a-z][a-z0-9-]*)\]/i;
const CLARIFY_TAG_RE = /\[CLARIFY:\s*(.+?)\]/i;

// ── Tag helpers ───────────────────────────────────────────────────────────────

/** Extract agent-id from [REDIRECT: <agent-id>] tag. Returns null if absent. */
function parseRedirectSignal(response: string): string | null {
  const m = response.match(REDIRECT_TAG_RE);
  return m ? m[1].toLowerCase() : null;
}

/** Extract question from [CLARIFY: <question>] tag. Returns null if absent. */
function parseClarifySignal(response: string): string | null {
  const m = response.match(CLARIFY_TAG_RE);
  return m ? m[1].trim() : null;
}

/** Remove [REDIRECT:] and [CLARIFY:] tags before storing or displaying. */
function stripSignalTags(response: string): string {
  return response
    .replace(REDIRECT_TAG_RE, "")
    .replace(CLARIFY_TAG_RE, "")
    .trim();
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Run the NLAH harness for a confirmed dispatch.
 *
 * @param resumeFrom  Optional persisted state to resume from (skips "done" steps).
 *                    Use when an executor re-runs after a "suspended" clarification cycle.
 */
export async function runHarness(
  bot: Bot,
  plan: DispatchPlan,
  ccChatId: number,
  ccThreadId: number | null,
  opts?: { resumeFrom?: DispatchState },
): Promise<HarnessResult> {
  let state: DispatchState;
  let stepIdx: number;

  if (opts?.resumeFrom) {
    // Resume — re-run the suspended step with the enriched prompt already in plan.userMessage
    state = { ...opts.resumeFrom, status: "in_progress", updatedAt: new Date().toISOString() };
    delete state.pendingQuestion;
    delete state.pendingAgent;

    stepIdx = state.steps.findIndex((s) => s.status === "suspended" || s.status === "pending");
    if (stepIdx === -1) {
      // All steps already done
      state.status = "done";
      await persistState(state);
      return { outcome: "done" };
    }
    // Reset the suspended/pending step so it re-runs
    state.steps[stepIdx].status = "pending";
    await persistState(state);
  } else {
    const contract = await loadContract(plan.classification.intent);
    // default.md is a generic fallback — honour the classified agent instead of operations-hub
    const isDefaultFallback = contract?.name === "default";
    const contractSteps = (!isDefaultFallback && contract?.steps) ? contract.steps : [];

    const steps: StepState[] = contractSteps.length > 0
      ? contractSteps.map((s) => ({ seq: s.seq, agent: s.agent, status: "pending" as StepStatus, output: null, durationMs: null }))
      : [{ seq: 1, agent: plan.classification.primaryAgent, status: "pending" as StepStatus, output: null, durationMs: null }];

    state = {
      dispatchId: plan.dispatchId,
      userMessage: plan.userMessage,
      contractFile: contract?.name ?? null,
      steps,
      status: "in_progress",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    stepIdx = 0;
    await persistState(state);
  }

  // Loop guard — skip agents that already ran (handles resume case too)
  const triedAgents = new Set<string>(
    state.steps.filter((s) => s.status === "done").map((s) => s.agent),
  );
  let redirectHops = 0;

  // while-loop (not for-of) so we can dynamically append redirect steps
  while (stepIdx < state.steps.length) {
    const step = state.steps[stepIdx];
    step.status = "in_progress";
    state.updatedAt = new Date().toISOString();
    await persistState(state);

    const stepPlan: DispatchPlan = {
      ...plan,
      classification: { ...plan.classification, primaryAgent: step.agent },
      tasks: [{ seq: step.seq, agentId: step.agent, topicHint: plan.classification.topicHint, taskDescription: plan.userMessage }],
    };

    const result = await executeSingleDispatch(bot, stepPlan, ccChatId, ccThreadId);

    // [CLARIFY:] takes precedence over [REDIRECT:] — suspend wins
    const clarifyQuestion = result.success ? parseClarifySignal(result.response) : null;
    const redirectTo = (!clarifyQuestion && result.success) ? parseRedirectSignal(result.response) : null;
    const cleanResponse = stripSignalTags(result.response);

    step.output = cleanResponse;
    step.durationMs = result.durationMs;
    triedAgents.add(step.agent);
    state.updatedAt = new Date().toISOString();

    // ── [CLARIFY:] — suspend and return so executor can raise intervention ────

    if (clarifyQuestion) {
      step.status = "suspended";
      state.status = "suspended";
      state.pendingQuestion = clarifyQuestion;
      state.pendingAgent = step.agent;
      await persistState(state);

      const agentName = AGENTS[step.agent]?.name ?? step.agent;
      await postCCNotice(
        bot,
        `❓ <b>${agentName}</b> needs clarification:\n\n${clarifyQuestion}`,
        ccChatId,
        ccThreadId,
      );

      return { outcome: "suspended", question: clarifyQuestion, agentId: step.agent };
    }

    // ── Normal result ─────────────────────────────────────────────────────────

    step.status = result.success ? "done" : "failed";
    await persistState(state);

    const resultMsgId = await postResult(bot, step.agent, { ...result, response: cleanResponse }, ccChatId, ccThreadId);
    if (resultMsgId) {
      trackAgentReply(ccChatId, resultMsgId, step.agent, ccThreadId);
    }
    trackLastActiveAgent(ccChatId, ccThreadId, step.agent);

    if (!result.success) {
      state.status = "failed";
      await persistState(state);
      return { outcome: "failed" };
    }

    // ── [REDIRECT:] handling ──────────────────────────────────────────────────

    if (redirectTo) {
      if (!AGENTS[redirectTo]) {
        console.warn(`[harness] Unknown redirect target "${redirectTo}" from ${step.agent} — ignoring`);
      } else if (triedAgents.has(redirectTo)) {
        const toName = AGENTS[redirectTo]?.name ?? redirectTo;
        await postCCNotice(bot, `⚠️ Circular redirect detected: <b>${toName}</b> already handled this request`, ccChatId, ccThreadId);
        state.status = "failed";
        await persistState(state);
        return { outcome: "failed", error: "circular redirect" };
      } else if (redirectHops >= MAX_REDIRECT_HOPS) {
        await postCCNotice(bot, `⚠️ Max redirect hops (${MAX_REDIRECT_HOPS}) reached — stopping dispatch`, ccChatId, ccThreadId);
        state.status = "failed";
        await persistState(state);
        return { outcome: "failed", error: "max redirect hops reached" };
      } else {
        redirectHops++;
        const fromName = AGENTS[step.agent]?.name ?? step.agent;
        const toName = AGENTS[redirectTo]?.name ?? redirectTo;
        await postCCNotice(bot, `↩️ <b>${fromName}</b> → <b>${toName}</b> (redirected)`, ccChatId, ccThreadId);

        state.steps.push({
          seq: state.steps.length + 1,
          agent: redirectTo,
          status: "pending",
          output: null,
          durationMs: null,
        });
        await persistState(state);
      }
    }

    stepIdx++;
  }

  state.status = "done";
  state.updatedAt = new Date().toISOString();
  await persistState(state);

  // Synthesis message for multi-step dispatches
  if (state.steps.length > 1) {
    const lines = state.steps.map((s) => {
      const icon = s.status === "done" ? "✅" : "❌";
      const agent = AGENTS[s.agent]?.name ?? s.agent;
      const sec = ((s.durationMs ?? 0) / 1000).toFixed(1);
      return `${icon} ${agent} (${sec}s)`;
    });
    const summary = `📋 <b>Dispatch complete</b>\n\n${lines.join("\n")}`;
    await bot.api.sendMessage(ccChatId, summary, {
      parse_mode: "HTML",
      message_thread_id: ccThreadId ?? undefined,
    }).catch(() => {});
  }

  return { outcome: "done" };
}

/** Load persisted harness state for a dispatchId. Returns null if not found. */
export async function loadHarnessState(dispatchId: string): Promise<DispatchState | null> {
  try {
    const raw = await readFile(
      join(homedir(), ".claude-relay", "harness", "state", `${dispatchId}.json`),
      "utf-8",
    );
    return JSON.parse(raw) as DispatchState;
  } catch {
    return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function postResult(
  bot: Bot,
  agentId: string,
  result: { success: boolean; response: string; durationMs: number },
  ccChatId: number,
  ccThreadId: number | null,
): Promise<number | null> {
  const agentName = AGENTS[agentId]?.name ?? agentId;
  const icon = result.success ? "✅" : "❌";
  const sec = (result.durationMs / 1000).toFixed(1);
  const header = `${icon} <b>${agentName}</b> — ${result.success ? "completed" : "failed"} (${sec}s)`;

  const chunks = splitMarkdown(result.response, 3800);
  let firstMsgId: number | null = null;

  for (let i = 0; i < chunks.length; i++) {
    const html = i === 0 ? `${header}\n\n${markdownToHtml(chunks[i])}` : markdownToHtml(chunks[i]);
    const sent = await bot.api.sendMessage(ccChatId, html, {
      parse_mode: "HTML",
      message_thread_id: ccThreadId ?? undefined,
    }).catch(async () => {
      const plain = decodeHtmlEntities(html.replace(/<[^>]+>/g, ""));
      for (const chunk of chunkMessage(plain)) {
        const s = await bot.api.sendMessage(ccChatId, chunk, {
          message_thread_id: ccThreadId ?? undefined,
        }).catch(() => null);
        if (i === 0 && firstMsgId === null && s) firstMsgId = s.message_id;
      }
      return null;
    });
    if (i === 0 && sent) firstMsgId = sent.message_id;
  }

  return firstMsgId;
}

async function postCCNotice(
  bot: Bot,
  html: string,
  ccChatId: number,
  ccThreadId: number | null,
): Promise<void> {
  await bot.api.sendMessage(ccChatId, html, {
    parse_mode: "HTML",
    message_thread_id: ccThreadId ?? undefined,
  }).catch(() => {});
}

export async function persistState(state: DispatchState): Promise<void> {
  try {
    const dir = join(homedir(), ".claude-relay", "harness", "state");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${state.dispatchId}.json`), JSON.stringify(state, null, 2));
  } catch (err) {
    console.warn("[harness] Failed to persist state:", err instanceof Error ? err.message : err);
  }
}
