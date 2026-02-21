/**
 * Two-Pass Model Router
 *
 * Pass 1: A lightweight classifier (Haiku) reads each incoming message and
 *   returns exactly one word — "handle", "sonnet", or "opus" — indicating
 *   how much reasoning the message requires.
 *
 * Pass 2: The resolved model is returned to the caller; it either continues
 *   in Haiku (handle) or spawns a new Claude process at the specified tier.
 *
 * Config lives in config/models.json (not .env — no secrets here).
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { claudeText } from "../claude-process.ts";

// ── Types ────────────────────────────────────────────────────────────────────

export type ClassifierDecision = "handle" | "sonnet" | "opus";

export interface ModelRouterConfig {
  enabled: boolean;
  classifierTimeoutMs: number;
  logTierDecisions: boolean;
  firstPassModel: string;
  firstPassFallback: string;
  secondPassModel: string;
  secondPassFallback: string;
  thirdPassModel: string;
  thirdPassFallback: string;
  opusEnabled: boolean;
}

export interface RoutingResult {
  /** Full model ID to pass to the Claude CLI --model flag */
  model: string;
  /** Short display label for progress indicator lines, e.g. "Haiku", "Sonnet", "Opus" */
  displayName: string;
  /** The tier decision made by the classifier */
  decision: ClassifierDecision;
}

// ── Classification prompt ────────────────────────────────────────────────────

const CLASSIFIER_SYSTEM_PROMPT = `You are a routing classifier. Respond with exactly one word.
Reply "handle" for simple questions, lookups, short tasks, chit-chat, or anything Haiku can answer confidently (< 2 paragraphs, no code, no research).
Reply "sonnet" for moderate complexity: code generation, technical explanations, analysis, multi-step reasoning, document drafting.
Reply "opus" only for the hardest tasks: deep architecture design, complex multi-system reasoning, long-form research synthesis, or critical decisions.
Only output the single word. No explanation.`;

// ── Config loading ───────────────────────────────────────────────────────────

const SAFE_DEFAULTS: ModelRouterConfig = {
  enabled: false,
  classifierTimeoutMs: 8000,
  logTierDecisions: false,
  firstPassModel: "claude-haiku-4-5-20251001",
  firstPassFallback: "gemma3:4b",
  secondPassModel: "claude-sonnet-4-6",
  secondPassFallback: "gemma3:4b",
  thirdPassModel: "claude-opus-4-6",
  thirdPassFallback: "gemma3:4b",
  opusEnabled: false,
};

/**
 * Read config/models.json once at startup and return a ModelRouterConfig.
 * Falls back to safe defaults (routing disabled) if the file is missing or invalid.
 */
export function loadModelRouterConfig(): ModelRouterConfig {
  try {
    const projectRoot = dirname(dirname(new URL(import.meta.url).pathname));
    const configPath = join(projectRoot, "config", "models.json");
    const raw = readFileSync(configPath, "utf-8");
    const json = JSON.parse(raw);
    const r = json.routing;
    return {
      enabled: Boolean(r.enabled ?? true),
      classifierTimeoutMs: Number(r.classifierTimeoutMs ?? 8000),
      logTierDecisions: Boolean(r.logTierDecisions ?? false),
      firstPassModel: String(r.firstPass?.model ?? "claude-haiku-4-5-20251001"),
      firstPassFallback: String(r.firstPass?.fallback ?? "gemma3:4b"),
      secondPassModel: String(r.secondPass?.model ?? "claude-sonnet-4-6"),
      secondPassFallback: String(r.secondPass?.fallback ?? "gemma3:4b"),
      thirdPassModel: String(r.thirdPass?.model ?? "claude-opus-4-6"),
      thirdPassFallback: String(r.thirdPass?.fallback ?? "gemma3:4b"),
      opusEnabled: Boolean(r.thirdPass?.enabled ?? false),
    };
  } catch {
    console.warn("[Router] Could not load config/models.json — routing disabled");
    return { ...SAFE_DEFAULTS };
  }
}

// ── Display name ─────────────────────────────────────────────────────────────

/**
 * Derive a short human-readable label from a model ID string.
 *
 *   "claude-haiku-*"  → "Haiku"
 *   "claude-sonnet-*" → "Sonnet"
 *   "claude-opus-*"   → "Opus"
 *   "gemma3:4b"       → "gemma3"   (text before first ":")
 *   "other-model"     → "other"    (text before first "-")
 */
export function modelDisplayName(modelId: string): string {
  const lower = modelId.toLowerCase();
  if (lower.includes("claude-haiku")) return "Haiku";
  if (lower.includes("claude-sonnet")) return "Sonnet";
  if (lower.includes("claude-opus")) return "Opus";
  // anything with a colon (ollama-style): take the part before ":"
  const colonIdx = modelId.indexOf(":");
  if (colonIdx > 0) return modelId.slice(0, colonIdx);
  // fallback: take the part before the first "-"
  const dashIdx = modelId.indexOf("-");
  if (dashIdx > 0) return modelId.slice(0, dashIdx);
  return modelId;
}

// ── Classifier (Pass 1) ──────────────────────────────────────────────────────

/**
 * Call the classifier model with the user message and return a tier decision.
 * Exported for unit testing.
 *
 * On timeout, parse error, or unexpected output → defaults to "sonnet".
 */
export async function classify(
  userMessage: string,
  config: ModelRouterConfig
): Promise<ClassifierDecision> {
  try {
    const prompt = `${CLASSIFIER_SYSTEM_PROMPT}\n\nUser: ${userMessage}`;
    const raw = await claudeText(prompt, {
      model: config.firstPassModel,
      timeoutMs: config.classifierTimeoutMs,
    });
    const decision = raw.trim().toLowerCase();
    if (decision === "handle" || decision === "sonnet" || decision === "opus") {
      return decision;
    }
    return "sonnet";
  } catch {
    return "sonnet";
  }
}

// ── Resolver (entry point) ───────────────────────────────────────────────────

/**
 * Resolve the model to use for this message.
 *
 * When routing is disabled: always returns the secondPass (Sonnet) model.
 * When routing is enabled: runs the classifier and maps the decision to a model.
 *
 * Logs the decision to console when config.logTierDecisions is true.
 */
export async function resolveModel(
  userMessage: string,
  config: ModelRouterConfig
): Promise<RoutingResult> {
  // Short-circuit when routing is disabled
  if (!config.enabled) {
    return {
      model: config.secondPassModel,
      displayName: modelDisplayName(config.secondPassModel),
      decision: "sonnet",
    };
  }

  try {
    const decision = await classify(userMessage, config);

    let model: string;
    if (decision === "handle") {
      model = config.firstPassModel;
    } else if (decision === "opus" && config.opusEnabled) {
      model = config.thirdPassModel;
    } else {
      // "sonnet", or "opus" with Opus disabled → Sonnet
      model = config.secondPassModel;
    }

    if (config.logTierDecisions) {
      console.log(`[Router] ${decision} → ${model}`);
    }

    return { model, displayName: modelDisplayName(model), decision };
  } catch {
    // Defensive fallback — should not normally reach here since classify() already catches
    return {
      model: config.secondPassModel,
      displayName: modelDisplayName(config.secondPassModel),
      decision: "sonnet",
    };
  }
}
