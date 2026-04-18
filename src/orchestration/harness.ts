/**
 * NLAH Harness — Thin Event Loop
 *
 * Loads a contract, executes steps sequentially, writes a state file,
 * and posts each step's result to the CC thread.
 *
 * Redirect routing: agents may include [REDIRECT: <agent-id>] in their response
 * to signal the harness to re-route the original request to a different agent.
 * Loop guard: max 3 redirect hops; circular redirects are detected and aborted.
 */

import type { Bot } from "grammy";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { loadContract } from "./contractLoader.ts";
import { executeSingleDispatch } from "./dispatchEngine.ts";
import { markdownToHtml, splitMarkdown } from "../utils/htmlFormat.ts";
import { chunkMessage } from "../utils/sendToGroup.ts";
import type { DispatchPlan } from "./types.ts";
import { AGENTS } from "../agents/config.ts";
import { trackAgentReply, trackLastActiveAgent } from "./pendingAgentReplies.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export type StepStatus = "pending" | "in_progress" | "done" | "failed";
export type HarnessStatus = "in_progress" | "done" | "failed" | "cancelled";

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
  createdAt: string;
  updatedAt: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_REDIRECT_HOPS = 3;
const REDIRECT_TAG_RE = /\[REDIRECT:\s*([a-z][a-z0-9-]*)\]/i;

// ── Redirect helpers ──────────────────────────────────────────────────────────

/** Extract agent-id from [REDIRECT: <agent-id>] tag. Returns null if absent. */
function parseRedirectSignal(response: string): string | null {
  const m = response.match(REDIRECT_TAG_RE);
  return m ? m[1].toLowerCase() : null;
}

/** Remove [REDIRECT: ...] tag from response before storing or displaying. */
function stripRedirectTag(response: string): string {
  return response.replace(REDIRECT_TAG_RE, "").trim();
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Run the NLAH harness for a confirmed dispatch.
 * Loads the matching contract, executes steps sequentially, posts results to CC.
 * State is persisted to ~/.claude-relay/harness/state/{dispatchId}.json after each step.
 *
 * Redirect routing: if an agent responds with [REDIRECT: <agent-id>], a new step
 * is appended and the original userMessage is re-dispatched to the target agent.
 * Loop guard: MAX_REDIRECT_HOPS (3) hard cap; circular redirects abort immediately.
 */
export async function runHarness(
  bot: Bot,
  plan: DispatchPlan,
  ccChatId: number,
  ccThreadId: number | null,
): Promise<void> {
  const contract = await loadContract(plan.classification.intent);
  // default.md is a generic fallback — when it matches, honour the classified agent
  // instead of overriding to operations-hub.
  const isDefaultFallback = contract?.name === "default";
  const contractSteps = (!isDefaultFallback && contract?.steps) ? contract.steps : [];

  // Build initial step list from contract if multi-step, else single step from classification
  const steps: StepState[] = contractSteps.length > 0
    ? contractSteps.map((s) => ({ seq: s.seq, agent: s.agent, status: "pending", output: null, durationMs: null }))
    : [{ seq: 1, agent: plan.classification.primaryAgent, status: "pending", output: null, durationMs: null }];

  const state: DispatchState = {
    dispatchId: plan.dispatchId,
    userMessage: plan.userMessage,
    contractFile: contract?.name ?? null,
    steps,
    status: "in_progress",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await persistState(state);

  // Loop guard state — local to this run, GC'd on return
  const triedAgents = new Set<string>();
  let redirectHops = 0;
  let stepIdx = 0;

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

    // Parse redirect before storing — strip tag from persisted/displayed output
    const redirectTo = result.success ? parseRedirectSignal(result.response) : null;
    const cleanResponse = stripRedirectTag(result.response);

    step.output = cleanResponse;
    step.durationMs = result.durationMs;
    step.status = result.success ? "done" : "failed";
    triedAgents.add(step.agent);
    state.updatedAt = new Date().toISOString();
    await persistState(state);

    const resultMsgId = await postResult(bot, step.agent, { ...result, response: cleanResponse }, ccChatId, ccThreadId);
    if (resultMsgId) {
      trackAgentReply(ccChatId, resultMsgId, step.agent, ccThreadId);
    }
    // Track as last active so bare follow-ups ("merge", "ok") route to this agent
    trackLastActiveAgent(ccChatId, ccThreadId, step.agent);

    if (!result.success) {
      state.status = "failed";
      await persistState(state);
      return;
    }

    // ── Redirect handling ────────────────────────────────────────────────────

    if (redirectTo) {
      if (!AGENTS[redirectTo]) {
        // Unknown agent — ignore silently (warn in logs)
        console.warn(`[harness] Unknown redirect target "${redirectTo}" from ${step.agent} — ignoring`);
      } else if (triedAgents.has(redirectTo)) {
        // Circular redirect guard
        const toName = AGENTS[redirectTo]?.name ?? redirectTo;
        await postCCNotice(bot, `⚠️ Circular redirect detected: <b>${toName}</b> already handled this request`, ccChatId, ccThreadId);
        state.status = "failed";
        await persistState(state);
        return;
      } else if (redirectHops >= MAX_REDIRECT_HOPS) {
        // Hop limit guard
        await postCCNotice(bot, `⚠️ Max redirect hops (${MAX_REDIRECT_HOPS}) reached — stopping dispatch`, ccChatId, ccThreadId);
        state.status = "failed";
        await persistState(state);
        return;
      } else {
        // Valid redirect — append new step and notify CC
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

  // Post synthesis header for multi-step dispatches (includes redirected steps)
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
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Post agent result chunks to CC thread. Returns first chunk's message_id (for reply tracking). */
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
      // Telegram rejected HTML → plain text fallback
      const plain = i === 0
        ? `${icon} ${agentName} — ${result.success ? "completed" : "failed"} (${sec}s)\n\n${chunks[i]}`
        : chunks[i];
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

/** Post a short notice (redirect notification or guard warning) to the CC thread. */
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

async function persistState(state: DispatchState): Promise<void> {
  try {
    const dir = join(homedir(), ".claude-relay", "harness", "state");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${state.dispatchId}.json`), JSON.stringify(state, null, 2));
  } catch (err) {
    // State persistence is audit-only — never block dispatch
    console.warn("[harness] Failed to persist state:", err instanceof Error ? err.message : err);
  }
}
