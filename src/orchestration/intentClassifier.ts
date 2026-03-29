/**
 * Intent Classifier
 *
 * Routes user messages to the best-fit agent using:
 * 1. MLX local model (Qwen3.5-9B) for structured JSON classification
 * 2. Keyword fallback against agent capabilities[] when MLX is unavailable
 *
 * Complexity: O(1) MLX call (~200-400ms) + O(n) keyword fallback (n = agents x capabilities)
 */

import { callMlxGenerate, isMlxAvailable } from "../mlx/client.ts";
import { AGENTS, DEFAULT_AGENT, type AgentConfig } from "../agents/config.ts";
import type { ClassificationResult } from "./types.ts";

/** Minimum confidence to auto-dispatch without user confirmation */
export const AUTO_DISPATCH_THRESHOLD = 0.6;

/** Agents eligible for orchestration routing (excludes command-center itself) */
function getRoutableAgents(): AgentConfig[] {
  return Object.values(AGENTS).filter((a) => a.id !== "command-center");
}

/**
 * Classify a user message to determine which agent should handle it.
 *
 * Tries MLX first, falls back to keyword matching if MLX is unavailable or errors.
 */
export async function classifyIntent(message: string): Promise<ClassificationResult> {
  try {
    const mlxAvailable = await isMlxAvailable();
    if (mlxAvailable) {
      return await classifyWithMlx(message);
    }
  } catch (err) {
    console.warn("[intentClassifier] MLX classification failed, using keyword fallback:", err);
  }

  return classifyWithKeywords(message);
}

// ── MLX Classification ──────────────────────────────────────────────────────

async function classifyWithMlx(message: string): Promise<ClassificationResult> {
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
- For general questions or small talk, use "operations-hub"`;

  const raw = await callMlxGenerate(prompt, { maxTokens: 256, timeoutMs: 15_000 });

  // Extract JSON from response (MLX may wrap in markdown code blocks)
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.warn("[intentClassifier] MLX returned non-JSON, falling back to keywords:", raw.slice(0, 200));
    return classifyWithKeywords(message);
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

    // Validate primaryAgent exists
    const agentId = String(parsed.primaryAgent ?? "");
    if (!agents.some((a) => a.id === agentId)) {
      console.warn(`[intentClassifier] MLX returned unknown agent "${agentId}", falling back`);
      return classifyWithKeywords(message);
    }

    return {
      intent: String(parsed.intent ?? "general"),
      primaryAgent: agentId,
      topicHint: parsed.topicHint ? String(parsed.topicHint) : null,
      isCompound: Boolean(parsed.isCompound),
      confidence: Math.min(1, Math.max(0, Number(parsed.confidence ?? 0.5))),
      reasoning: String(parsed.reasoning ?? "Classified by local model"),
    };
  } catch (err) {
    console.warn("[intentClassifier] Failed to parse MLX JSON:", err);
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

  // Normalize score to 0-1 confidence
  const confidence = bestScore >= 3 ? 0.85 : bestScore >= 2 ? 0.7 : bestScore >= 1 ? 0.5 : 0.3;

  return {
    intent: bestCapability || "general",
    primaryAgent: bestAgent.id,
    topicHint: null,
    isCompound: false,
    confidence,
    reasoning: bestScore > 0
      ? `Keyword match: "${bestCapability}" → ${bestAgent.name}`
      : `No strong keyword match — routing to ${bestAgent.name} (default)`,
  };
}
