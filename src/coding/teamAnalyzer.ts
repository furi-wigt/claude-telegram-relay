/**
 * Analyzes a task description and determines the optimal agent team composition
 * for Claude Code's experimental agent teams feature.
 *
 * Uses a cascade fallback pattern:
 *   1. Claude CLI (`claude --print`) — AI-powered team suggestion
 *   2. Ollama REST API — local LLM fallback
 *   3. Pattern matching — hardcoded rules, no external dependencies
 */

import { callOllamaGenerate } from "../ollama.ts";
import { claudeText } from "../claude-process.ts";

/**
 * Injectable dependencies — allows tests to override callOllamaGenerate and claudeText
 * without mock.module(), avoiding bun module-cache pollution across test files.
 */
export const _deps = {
  callOllamaGenerate,
  claudeText,
};

export interface TeamRole {
  name: string;  // e.g., "implementer", "reviewer", "tester"
  focus: string; // what this role focuses on
}

export interface TeamComposition {
  roles: TeamRole[];
  strategy: string;         // e.g., "parallel implementation with review"
  orchestrationPrompt: string; // full prefix to inject into the task
}

// Pattern matchers: order matters — first match wins
interface PatternRule {
  pattern: RegExp;
  roles: TeamRole[];
  strategy: string;
}

const PATTERN_RULES: PatternRule[] = [
  {
    pattern: /\b(debug|fix|investigate|diagnose|error|bug|crash|fail|broken|exception|traceback)\b/i,
    roles: [
      { name: "lead-investigator", focus: "reproduce the issue and identify root cause" },
      { name: "hypothesis-tester-a", focus: "test whether the problem is environmental or configuration-related" },
      { name: "hypothesis-tester-b", focus: "test whether the problem is a logic or data issue" },
    ],
    strategy: "parallel root-cause investigation",
  },
  {
    pattern: /\b(review|audit|check|analyze|security|vulnerability|compliance|inspect)\b/i,
    roles: [
      { name: "security-reviewer", focus: "identify security vulnerabilities and risks" },
      { name: "performance-reviewer", focus: "identify performance bottlenecks and inefficiencies" },
      { name: "coverage-reviewer", focus: "assess test coverage and code quality" },
    ],
    strategy: "multi-dimensional code review",
  },
  {
    pattern: /\b(refactor|cleanup|clean up|improve|optimise|optimize|simplify|reorganize|restructure)\b/i,
    roles: [
      { name: "refactorer", focus: "apply refactoring changes and improve code structure" },
      { name: "reviewer", focus: "validate that refactoring preserves correctness and intent" },
      { name: "test-validator", focus: "ensure all tests remain green after changes" },
    ],
    strategy: "safe refactoring with validation",
  },
  {
    pattern: /\b(test|spec|coverage|tdd|unit test|integration test|e2e|end.to.end|write tests|add tests)\b/i,
    roles: [
      { name: "test-writer", focus: "write comprehensive tests covering all cases" },
      { name: "implementation-verifier", focus: "verify tests accurately reflect requirements and are correct" },
    ],
    strategy: "test-driven development",
  },
  {
    pattern: /\b(research|compare|evaluate|benchmark|survey|investigate options|feasibility)\b/i,
    roles: [
      { name: "researcher-a", focus: "explore the primary approach and its trade-offs" },
      { name: "researcher-b", focus: "explore alternative approaches and compare options" },
      { name: "researcher-c", focus: "synthesize findings and recommend the best path forward" },
    ],
    strategy: "parallel research with synthesis",
  },
  {
    pattern: /\b(design|architect|blueprint|system design|api design|plan)\b/i,
    roles: [
      { name: "architect", focus: "design the overall system structure and key decisions" },
      { name: "critic", focus: "challenge assumptions and identify weaknesses in the design" },
      { name: "implementability-checker", focus: "validate the design is practical and can be built incrementally" },
    ],
    strategy: "design with critical review",
  },
  {
    pattern: /\b(implement|add|create|build|write|develop|make|generate|scaffold|setup|set up)\b/i,
    roles: [
      { name: "implementer", focus: "write the implementation code following best practices" },
      { name: "reviewer", focus: "review implementation for correctness, edge cases, and code quality" },
      { name: "tester", focus: "write and verify tests for the new implementation" },
    ],
    strategy: "parallel implementation with review",
  },
];

// Default fallback when no patterns match
const DEFAULT_ROLES: TeamRole[] = [
  { name: "implementer", focus: "execute the primary task" },
  { name: "reviewer", focus: "review the work for quality and correctness" },
];
const DEFAULT_STRATEGY = "implementation with review";

// ---------------------------------------------------------------------------
// Shared prompt builder
// ---------------------------------------------------------------------------

/**
 * Builds the JSON prompt to send to AI providers asking for team composition.
 */
function buildAiPrompt(task: string): string {
  return (
    `Analyze this coding task and suggest an optimal agent team composition. ` +
    `Output ONLY valid JSON with this exact structure:\n` +
    `{"strategy": "...", "roles": [{"name": "...", "focus": "..."}]}\n` +
    `Rules: 2-5 roles, names are short lowercase labels, focus is one sentence.\n\n` +
    `Task: ${task}`
  );
}

// ---------------------------------------------------------------------------
// Shared orchestration prompt builder
// ---------------------------------------------------------------------------

/**
 * Builds the orchestration prompt injected into the task for Claude agents.
 * All three cascade paths use this function — format is always identical.
 */
function buildOrchestrationPrompt(task: string, roles: TeamRole[]): string {
  const roleLines = roles
    .map((r) => `- ${r.name}: ${r.focus}`)
    .join("\n");

  return (
    `Create an agent team to accomplish the following task. ` +
    `Spawn the teammates below and coordinate their work:\n` +
    `${roleLines}\n\n` +
    `Task: ${task}`
  );
}

// ---------------------------------------------------------------------------
// Claude CLI caller (primary)
// ---------------------------------------------------------------------------

/**
 * Calls Claude CLI with --print flag to get an AI-suggested team composition.
 * Timeout: 10 seconds.
 * Throws on process error or invalid JSON response.
 */
export async function analyzeWithClaude(task: string): Promise<TeamComposition> {
  const prompt = buildAiPrompt(task);

  let stdout: string;
  try {
    stdout = await _deps.claudeText(prompt, { timeoutMs: 30_000 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("empty response")) {
      throw new Error("Claude CLI: no JSON object found in output");
    }
    throw err;
  }

  // Extract JSON from the output — Claude may include prose around it
  const jsonMatch = stdout.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Claude CLI: no JSON object found in output");
  }

  const parsed = JSON.parse(jsonMatch[0]) as { strategy?: unknown; roles?: unknown };

  if (
    typeof parsed.strategy !== "string" ||
    !Array.isArray(parsed.roles) ||
    parsed.roles.length < 2
  ) {
    throw new Error("Claude CLI: no JSON object found in output");
  }

  const roles = (parsed.roles as Array<{ name?: unknown; focus?: unknown }>).map((r) => {
    if (typeof r.name !== "string" || typeof r.focus !== "string") {
      throw new Error("Claude CLI: role missing name or focus");
    }
    return { name: r.name, focus: r.focus };
  });

  const trimmedTask = task.trim();
  console.debug("[teamAnalyzer] source=claude-cli strategy=%s roles=%d", parsed.strategy, roles.length);

  return {
    roles,
    strategy: parsed.strategy,
    orchestrationPrompt: buildOrchestrationPrompt(trimmedTask, roles),
  };
}

// ---------------------------------------------------------------------------
// Ollama REST API caller (secondary)
// ---------------------------------------------------------------------------

/**
 * Calls Ollama REST API to get an LLM-suggested team composition.
 * Delegates the HTTP call to callOllamaGenerate from src/ollama.ts.
 * Model: OLLAMA_MODEL env var (via ollama.ts defaults).
 * Timeout: 30 seconds.
 * Throws on network error or invalid JSON response.
 */
export async function analyzeWithOllama(task: string): Promise<TeamComposition> {
  const model = process.env.OLLAMA_MODEL ?? "llama3.2";
  const baseUrl = process.env.OLLAMA_URL; // undefined = use ollama.ts default
  const prompt = buildAiPrompt(task);

  // Delegate the raw HTTP call to the shared Ollama utility.
  // Pass a 30s timeout (longer than the default 10s used for summarization).
  const rawText = await _deps.callOllamaGenerate(prompt, { model, baseUrl, timeoutMs: 30_000 });

  // Extract JSON from Ollama's text response
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Ollama API: no JSON object found in response");
  }

  const parsed = JSON.parse(jsonMatch[0]) as { strategy?: unknown; roles?: unknown };

  if (
    typeof parsed.strategy !== "string" ||
    !Array.isArray(parsed.roles) ||
    parsed.roles.length < 2
  ) {
    throw new Error("Ollama API: JSON structure invalid");
  }

  const roles = (parsed.roles as Array<{ name?: unknown; focus?: unknown }>).map((r) => {
    if (typeof r.name !== "string" || typeof r.focus !== "string") {
      throw new Error("Ollama API: role missing name or focus");
    }
    return { name: r.name, focus: r.focus };
  });

  const trimmedTask = task.trim();
  console.debug("[teamAnalyzer] source=ollama model=%s strategy=%s roles=%d", model, parsed.strategy, roles.length);

  return {
    roles,
    strategy: parsed.strategy,
    orchestrationPrompt: buildOrchestrationPrompt(trimmedTask, roles),
  };
}

// ---------------------------------------------------------------------------
// Hardcoded pattern-matching fallback
// ---------------------------------------------------------------------------

/**
 * Analyzes a task using hardcoded keyword patterns.
 * This is the original synchronous implementation, preserved exactly.
 * Now a private implementation detail called by the cascade as last resort.
 */
export function analyzeTaskHardcoded(task: string): TeamComposition {
  const trimmedTask = task.trim();

  // Find the first matching rule
  let roles = DEFAULT_ROLES;
  let strategy = DEFAULT_STRATEGY;

  for (const rule of PATTERN_RULES) {
    if (rule.pattern.test(trimmedTask)) {
      roles = rule.roles;
      strategy = rule.strategy;
      break;
    }
  }

  console.debug("[teamAnalyzer] source=hardcoded strategy=%s roles=%d", strategy, roles.length);

  return {
    roles,
    strategy,
    orchestrationPrompt: buildOrchestrationPrompt(trimmedTask, roles),
  };
}

// ---------------------------------------------------------------------------
// Public cascade entry point
// ---------------------------------------------------------------------------

/**
 * Analyzes a task and returns the optimal agent team composition.
 *
 * Cascade order:
 *   1. Claude CLI (--print) — 10s timeout
 *   2. Ollama REST API      — 30s timeout
 *   3. Hardcoded patterns   — always succeeds
 */
export async function analyzeTaskForTeam(task: string): Promise<TeamComposition> {
  // Primary: Claude CLI
  try {
    return await analyzeWithClaude(task);
  } catch (err) {
    console.debug("[teamAnalyzer] Claude CLI failed: %s — trying Ollama", String(err));
  }

  // Secondary: Ollama
  try {
    return await analyzeWithOllama(task);
  } catch (err) {
    console.debug("[teamAnalyzer] Ollama failed: %s — using hardcoded fallback", String(err));
  }

  // Fallback: hardcoded pattern matching
  return analyzeTaskHardcoded(task);
}
