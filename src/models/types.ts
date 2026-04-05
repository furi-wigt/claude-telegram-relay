// src/models/types.ts

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  maxTokens?: number;
  timeoutMs?: number;
  chunkTimeoutMs?: number;
  label?: string;
}

export interface CircuitBreakerConfig {
  enabled: boolean;
  failureThreshold: number;
  resetAfterMs: number;
}

export interface ProviderConfig {
  id: string;
  type: "openai-compat" | "claude";
  url?: string;          // openai-compat only
  model: string;
  dimensions?: number;   // embed providers only
  timeoutMs?: number;
  chunkTimeoutMs?: number;
  maxConcurrent?: number;
  circuitBreaker?: CircuitBreakerConfig;
}

export interface SlotsConfig {
  routine: string[];
  stm: string[];
  ltm: string[];
  classify: string[];
  embed: [string];       // exactly one entry
}

export interface ModelsConfig {
  providers: ProviderConfig[];
  slots: SlotsConfig;
}

export type ChatSlot = "routine" | "stm" | "ltm" | "classify";

export interface CascadeAttempt {
  providerId: string;
  error: string;
}

export class CascadeExhaustedError extends Error {
  attempts: CascadeAttempt[];
  constructor(slot: string, attempts: CascadeAttempt[]) {
    super(`All providers exhausted for slot "${slot}": ${attempts.map(a => `${a.providerId}(${a.error})`).join(", ")}`);
    this.name = "CascadeExhaustedError";
    this.attempts = attempts;
  }
}

export class ModelConfigError extends Error {
  issues: string[];
  constructor(issues: string[]) {
    super(`Invalid models.json: ${issues.join("; ")}`);
    this.name = "ModelConfigError";
    this.issues = issues;
  }
}
