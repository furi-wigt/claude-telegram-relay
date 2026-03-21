/**
 * Centralized Ollama model registry.
 *
 * Maps each purpose to an env var override, falling back to
 * OLLAMA_MODEL (global) then a compiled default.
 *
 * Resolution order per purpose:
 *   1. Purpose-specific env var (e.g. OLLAMA_CHAT_MODEL)
 *   2. OLLAMA_MODEL (global override)
 *   3. Compiled default
 */

export type OllamaPurpose =
  | "chat-fallback"
  | "memory-summary"
  | "memory-conflict"
  | "context-relevance"
  | "stm-summary"
  | "team-analysis"
  | "routine-summary"
  | "ltm-extraction"
  | "topic-generation";

const DEFAULT_MODEL = "qwen2.5:7b-instruct-Q6_K";

const ENV_MAP: Record<OllamaPurpose, string> = {
  "chat-fallback": "OLLAMA_CHAT_MODEL",
  "memory-summary": "OLLAMA_MEMORY_MODEL",
  "memory-conflict": "OLLAMA_CONFLICT_MODEL",
  "context-relevance": "OLLAMA_RELEVANCE_MODEL",
  "stm-summary": "OLLAMA_STM_MODEL",
  "team-analysis": "OLLAMA_ANALYSIS_MODEL",
  "routine-summary": "OLLAMA_ROUTINE_MODEL",
  "ltm-extraction": "OLLAMA_LTM_MODEL",
  "topic-generation": "OLLAMA_TOPIC_MODEL",
};

/**
 * Resolve the model name for a given purpose.
 * Reads env vars per-call so tests can override freely.
 */
export function getModel(purpose: OllamaPurpose): string {
  return (
    process.env[ENV_MAP[purpose]] ??
    process.env.OLLAMA_MODEL ??
    DEFAULT_MODEL
  );
}

/** All known purposes — useful for health checks and diagnostics. */
export const ALL_PURPOSES: readonly OllamaPurpose[] = Object.keys(ENV_MAP) as OllamaPurpose[];

/** Env var name for a purpose — useful for error messages. */
export function getEnvVar(purpose: OllamaPurpose): string {
  return ENV_MAP[purpose];
}
