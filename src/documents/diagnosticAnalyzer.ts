/**
 * Diagnostic Analyzer
 *
 * Provides domain-specific image extraction prompts for specialized agents.
 * When an agent has `diagnostics.enabled: true`, images are analyzed with
 * a structured extraction prompt instead of the user's generic caption.
 *
 * Prompt resolution (in priority order):
 *   1. config/prompts/diagnostics/<agent-id>.md  (user override — gitignored local customization)
 *   2. BUILT_IN_DEFAULTS[agentId]                (hardcoded default — works out of the box)
 *   3. Generic fallback                          (unknown agentId)
 *
 * To customize for your deployment: create config/prompts/diagnostics/<agent-id>.md
 * and it will be used in place of the built-in. No TypeScript changes needed.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { analyzeImages, combineImageContexts } from "../vision/visionClient.ts";

// ─── Built-in extraction prompts ──────────────────────────────────────────────

/**
 * Default domain-specific extraction prompts per agent.
 * These instruct the vision model to extract structured data from screenshots
 * rather than describe the image generically.
 *
 * Overridable per-deployment via config/prompts/diagnostics/<agentId>.md.
 */
export const BUILT_IN_DEFAULTS: Record<string, string> = {
  "aws-architect": `You are analyzing a technical screenshot sent to an AWS Cloud Architect for troubleshooting.
Extract all visible technical information in structured form:
- If this is a CloudWatch dashboard: metric names, current values, units, alarm states (OK/ALARM/INSUFFICIENT_DATA), threshold values, time ranges, service/resource names
- If this is a cost explorer or billing chart: service breakdown, total cost, time period, anomalies
- If this is an architecture diagram: components, connections, AWS service names, data flow direction
- If this is an error or console output: error messages, stack traces, status codes, affected resources

Return extracted data as concise bullet points. Do not interpret or recommend — only extract what is visible.`,

  "code-quality-coach": `You are analyzing a technical screenshot sent to a Code Quality & TDD Coach.
Extract all visible technical information in structured form:
- If this is a test output: test framework (pytest/jest/etc.), total tests, passed/failed/skipped counts, specific failing test names, assertion errors with expected vs actual values
- If this is a stack trace: error type, error message, file paths, line numbers, call chain
- If this is a code diff or PR: changed files, added/removed lines, function/class names affected
- If this is a profiler or coverage report: coverage percentage, uncovered lines, hotspot functions, timing data

Return extracted data as concise bullet points. Do not interpret or recommend — only extract what is visible.`,

  "security-analyst": `You are analyzing a technical screenshot sent to a Security & Compliance Analyst.
Extract all visible security-relevant information in structured form:
- If this is a vulnerability scan (Trivy, Snyk, etc.): CVE IDs, severity levels (CRITICAL/HIGH/MEDIUM/LOW), affected packages and versions, fix versions if shown
- If this is a network diagram: services, ports, protocols, trust boundaries, external connections
- If this is an access control matrix or IAM policy: principals, resources, actions, effect (Allow/Deny)
- If this is a security alert or dashboard: alert type, affected resource, timestamp, risk score

Return extracted data as concise bullet points. Do not interpret or recommend — only extract what is visible.`,
};

// ─── Prompt loader ────────────────────────────────────────────────────────────

const PROJECT_ROOT_DEFAULT = join(import.meta.dir, "..", "..");

/**
 * Load the extraction prompt for an agent.
 *
 * Priority order:
 * 1. config/prompts/diagnostics/<agentId>.md (if exists and non-empty)
 * 2. BUILT_IN_DEFAULTS[agentId]
 * 3. undefined (caller should apply generic fallback)
 */
export function loadExtractionPrompt(
  agentId: string,
  projectRoot?: string
): string | undefined {
  const root = projectRoot ?? PROJECT_ROOT_DEFAULT;
  const configPath = join(root, "config", "prompts", "diagnostics", `${agentId}.md`);

  try {
    const content = readFileSync(configPath, "utf-8").trim();
    if (content.length > 0) return content;
  } catch {
    // File doesn't exist or unreadable — fall through to built-in
  }

  return BUILT_IN_DEFAULTS[agentId];
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Analyze images using the agent-specific diagnostic extraction prompt.
 *
 * Returns a combined context string ready for <diagnostic_image> XML injection
 * into the agent prompt via promptBuilder.
 *
 * Falls back to a generic structured-extraction prompt if no built-in or
 * config-file prompt exists for the agent.
 *
 * @param imageBuffers  Raw image bytes (one per image)
 * @param agentId       Agent ID used to select the extraction prompt
 * @param projectRoot   Override project root (used in tests)
 */
export async function analyzeDiagnosticImages(
  imageBuffers: Buffer[],
  agentId: string,
  projectRoot?: string
): Promise<string> {
  const prompt =
    loadExtractionPrompt(agentId, projectRoot) ??
    "Describe all technical information visible in this image in structured bullet points.";

  const results = await analyzeImages(imageBuffers, prompt);
  return combineImageContexts(results);
}
