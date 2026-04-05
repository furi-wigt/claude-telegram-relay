/**
 * Intent Classifier
 *
 * Routes user messages to the best-fit agent using:
 * 1. MLX local model (Qwen3.5-9B) for structured JSON classification
 * 2. Keyword fallback against agent capabilities[] when MLX is unavailable
 *
 * Complexity: O(1) MLX call (~200-400ms) + O(n) keyword fallback (n = agents x capabilities)
 */

import { getRegistry } from "../models/index.ts";
import type { ChatMessage } from "../models/types.ts";
import { AGENTS, DEFAULT_AGENT, type AgentConfig } from "../agents/config.ts";
import type { ClassificationResult } from "./types.ts";

/** Minimum confidence to auto-dispatch without user confirmation */
export const AUTO_DISPATCH_THRESHOLD = 0.6;

/** Agents eligible for orchestration routing (excludes command-center itself) */
function getRoutableAgents(): AgentConfig[] {
  return Object.values(AGENTS).filter((a) => a.id !== "command-center");
}

// ── Compound Detection Heuristic ────────────────────────────────────────────

/** Conjunction patterns joining independent clauses. */
const COMPOUND_CONJUNCTIONS = /\b(?:and then|and also|as well as|and|also|plus|then)\b/gi;

/** Action verbs signalling discrete tasks. */
const ACTION_VERBS = /\b(?:write|draft|prepare|review|check|audit|create|build|implement|deploy|fix|update|analyze|summarize|present|send|schedule|plan|design|test|refactor|migrate|research|investigate)\b/gi;

/**
 * Detect whether a message describes a compound (multi-agent) task.
 *
 * Heuristic — compound if:
 * 1. 2+ conjunctions joining clauses, OR
 * 2. 2+ distinct action verbs with at least 1 conjunction, OR
 * 3. Message matches capabilities of 2+ different agents.
 *
 * Complexity: O(n) single pass over message + O(agents × capabilities).
 */
export function detectCompound(message: string): boolean {
  const lower = message.toLowerCase();

  const conjunctions = lower.match(COMPOUND_CONJUNCTIONS);
  const verbs = lower.match(ACTION_VERBS);

  // 2+ conjunctions → likely multi-part instruction
  if (conjunctions && conjunctions.length >= 2) return true;

  // 2+ distinct action verbs + at least 1 conjunction
  if (verbs && conjunctions) {
    const uniqueVerbs = new Set(verbs.map((v) => v.toLowerCase()));
    if (uniqueVerbs.size >= 2) return true;
  }

  // Matches capabilities of 2+ different agents — only if a conjunction is present
  // (prevents "review security posture" from being compound just because
  //  "review" matches engineering and "security" matches security-compliance)
  if (conjunctions && conjunctions.length >= 1) {
    const agents = getRoutableAgents();
    const matchedAgents = new Set<string>();
    for (const agent of agents) {
      for (const cap of agent.capabilities) {
        const capLower = cap.toLowerCase();
        if (lower.includes(capLower)) {
          matchedAgents.add(agent.id);
        } else {
          for (const w of capLower.split("-")) {
            if (w.length >= 4 && lower.includes(w)) {
              matchedAgents.add(agent.id);
              break;
            }
          }
        }
      }
      if (matchedAgents.size >= 2) return true;
    }
  }

  return false;
}

/**
 * Classify a user message to determine which agent should handle it.
 *
 * Tries registry classify slot first, falls back to keyword matching on error.
 */
export async function classifyIntent(message: string): Promise<ClassificationResult> {
  try {
    return await classifyWithRegistry(message);
  } catch (err) {
    // AbortError = timeout; log one-liner instead of full DOMException dump
    const name = err instanceof DOMException ? err.name : "";
    if (name === "AbortError") {
      console.warn("[intentClassifier] classify model timed out, using keyword fallback");
    } else {
      console.warn("[intentClassifier] classify model failed, using keyword fallback:", String(err));
    }
  }

  return classifyWithKeywords(message);
}

// ── Registry Classification ─────────────────────────────────────────────────

async function classifyWithRegistry(message: string): Promise<ClassificationResult> {
  const agents = getRoutableAgents();
  const agentList = agents
    .map((a) => `- ${a.id}: ${a.capabilities.join(", ")}`)
    .join("\n");

  const prompt = `You are a task router. Given these agents and their capabilities:
${agentList}

User message: "${message}"

Classify which agent should handle this. Return ONLY valid JSON (no markdown, no explanation):
{"intent":"<short-label>","primaryAgent":"<agent-id>","topicHint":null,"isCompound":false,"confidence":<0-1>,"reasoning":"<one-sentence>"}

Rules:
- primaryAgent MUST be one of: ${agents.map((a) => a.id).join(", ")}
- isCompound=true only if the task clearly requires 2+ different agents
- confidence: 0.9+ for exact domain match, 0.6-0.8 for reasonable match, <0.6 if unsure
- For general questions, small talk, or anything without a clear domain, ALWAYS use "operations-hub" with confidence 0.85`;

  const messages: ChatMessage[] = [{ role: "user", content: prompt }];
  const raw = await getRegistry().chat("classify", messages, { maxTokens: 256, label: "classify" });

  // Extract JSON from response (model may wrap in markdown code blocks)
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.warn("[intentClassifier] classify model returned non-JSON, falling back to keywords:", raw.slice(0, 200));
    return classifyWithKeywords(message);
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

    // Validate primaryAgent exists
    const agentId = String(parsed.primaryAgent ?? "");
    if (!agents.some((a) => a.id === agentId)) {
      console.warn(`[intentClassifier] classify model returned unknown agent "${agentId}", falling back`);
      return classifyWithKeywords(message);
    }

    // OR with heuristic — model may under-detect compound tasks
    const modelCompound = Boolean(parsed.isCompound);
    const heuristicCompound = detectCompound(message);

    return {
      intent: String(parsed.intent ?? "general"),
      primaryAgent: agentId,
      topicHint: parsed.topicHint ? String(parsed.topicHint) : null,
      isCompound: modelCompound || heuristicCompound,
      confidence: Math.min(1, Math.max(0, Number(parsed.confidence ?? 0.5))),
      reasoning: String(parsed.reasoning ?? "Classified by registry model"),
    };
  } catch (err) {
    console.warn("[intentClassifier] Failed to parse classify model JSON:", err);
    return classifyWithKeywords(message);
  }
}

// ── Keyword Fallback ────────────────────────────────────────────────────────

/** Score each agent by keyword overlap with the user message. O(agents × capabilities). */
export function classifyWithKeywords(message: string): ClassificationResult {
  const agents = getRoutableAgents();
  const lower = message.toLowerCase();
  const words = new Set(lower.split(/\s+/));

  let bestAgent = DEFAULT_AGENT;
  let bestScore = 0;
  let bestCapability = "";

  for (const agent of agents) {
    for (const cap of agent.capabilities) {
      // Split hyphenated capabilities for partial matching
      const capWords = cap.toLowerCase().split("-");
      let score = 0;

      // Exact capability match in message
      if (lower.includes(cap.toLowerCase())) {
        score = 3;
      } else {
        // Partial word match
        for (const w of capWords) {
          if (w.length >= 3 && words.has(w)) score += 1;
          else if (w.length >= 3 && lower.includes(w)) score += 0.5;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestAgent = agent;
        bestCapability = cap;
      }
    }
  }

  // Normalize score to 0-1 confidence.
  // Zero-score means no domain keyword matched → general question → ops-hub is the right default at high confidence.
  const confidence = bestScore >= 3 ? 0.85 : bestScore >= 2 ? 0.7 : bestScore >= 1 ? 0.5 : 0.8;

  return {
    intent: bestCapability || "general",
    primaryAgent: bestAgent.id,
    topicHint: null,
    isCompound: detectCompound(message),
    confidence,
    reasoning: bestScore > 0
      ? `Keyword match: "${bestCapability}" → ${bestAgent.name}`
      : `No strong keyword match — routing to ${bestAgent.name} (default)`,
  };
}
