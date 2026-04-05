// src/models/registry.ts
import { readFileSync } from "fs";
import { ModelsConfigSchema } from "./schema.ts";
import { CircuitBreaker } from "./circuitBreaker.ts";
import {
  type ModelsConfig,
  type ProviderConfig,
  type ChatSlot,
  type ChatMessage,
  type ChatOptions,
  type CascadeAttempt,
  CascadeExhaustedError,
  ModelConfigError,
} from "./types.ts";
import * as oaiClient from "./openaiCompatClient.ts";
import { claudeText } from "../claude-process.ts";

export class ModelRegistry {
  private providerMap: Map<string, ProviderConfig>;
  private breakers: Map<string, CircuitBreaker>;

  private constructor(private config: ModelsConfig) {
    this.providerMap = new Map(config.providers.map((p) => [p.id, p]));
    this.breakers = new Map();
    for (const p of config.providers) {
      if (p.circuitBreaker?.enabled) {
        this.breakers.set(p.id, new CircuitBreaker(p.circuitBreaker));
      }
    }
  }

  /** Load and validate config from a JSON file path. Throws ModelConfigError on bad config. */
  static load(configPath: string): ModelRegistry {
    const text = readFileSync(configPath, "utf-8");
    // Strip _comment keys before Zod validation (JSON comments workaround)
    const raw = JSON.parse(text, (key, value) =>
      key === "_comment" ? undefined : value
    );
    return ModelRegistry.fromConfig(raw);
  }

  /** Validate and construct from a parsed object (useful for tests). */
  static fromConfig(raw: unknown): ModelRegistry {
    const result = ModelsConfigSchema.safeParse(raw);
    if (!result.success) {
      const issues = result.error.issues.map((i) => i.message);
      throw new ModelConfigError(issues);
    }
    return new ModelRegistry(result.data as ModelsConfig);
  }

  /** Sanitized model name + dimensions for versioned Qdrant collection names. */
  embedCollectionSuffix(): string {
    const embedId = this.config.slots.embed[0];
    const provider = this.providerMap.get(embedId)!;
    const sanitized = provider.model.replace(/[^a-zA-Z0-9._-]/g, "-");
    const dims = provider.dimensions ?? 1024;
    return `${sanitized}_${dims}`;
  }

  /** Get embed dimensions from embed provider config. */
  getEmbedDimensions(): number {
    const embedId = this.config.slots.embed[0];
    return this.providerMap.get(embedId)?.dimensions ?? 1024;
  }

  private getBreaker(providerId: string): CircuitBreaker | undefined {
    return this.breakers.get(providerId);
  }

  /** Non-streaming cascade: tries providers in slot order, returns first success. */
  async chat(slot: ChatSlot, messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    const providerIds = this.config.slots[slot];
    const attempts: CascadeAttempt[] = [];

    for (const id of providerIds) {
      const provider = this.providerMap.get(id)!;
      const breaker = this.getBreaker(id);

      if (breaker?.isOpen()) {
        attempts.push({ providerId: id, error: "circuit open" });
        console.log(`[registry] cascade skip ${id} (circuit open) for slot ${slot}`);
        continue;
      }

      const healthy = await this.checkProviderHealth(provider);
      if (!healthy) {
        attempts.push({ providerId: id, error: "health check failed" });
        console.log(`[registry] cascade skip ${id} (unhealthy) for slot ${slot}`);
        continue;
      }

      try {
        const result = await this.callProvider(provider, messages, opts);
        breaker?.recordSuccess();
        return result;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        breaker?.recordFailure();
        attempts.push({ providerId: id, error });
        console.log(`[registry] cascade ${id} failed (${error}), trying next for slot ${slot}`);
      }
    }

    throw new CascadeExhaustedError(slot, attempts);
  }

  private async checkProviderHealth(provider: ProviderConfig): Promise<boolean> {
    if (provider.type === "claude") return true; // Claude CLI assumed present
    return oaiClient.health(provider.url!);
  }

  private async callProvider(
    provider: ProviderConfig,
    messages: ChatMessage[],
    opts: ChatOptions
  ): Promise<string> {
    const mergedOpts: ChatOptions = {
      timeoutMs: provider.timeoutMs,
      chunkTimeoutMs: provider.chunkTimeoutMs,
      maxTokens: opts.maxTokens,
      label: opts.label,
      ...opts,
    };

    if (provider.type === "openai-compat") {
      // Collect full response from SSE generator
      let result = "";
      for await (const chunk of oaiClient.chatStream(provider.url!, provider.model, messages, mergedOpts)) {
        result += chunk;
      }
      return result;
    }

    // Claude adapter: convert messages to prompt string for claudeText
    // Note: claudeText does not support maxTokens — omit it from options.
    const prompt = messages.map(m => `${m.role}: ${m.content}`).join("\n\n");
    return claudeText(prompt, {
      model: provider.model,
      timeoutMs: mergedOpts.timeoutMs,
    });
  }

  /**
   * Streaming chat with buffered cascade.
   * Buffers each provider's full response; yields only after clean commit.
   * On mid-stream failure: discards buffer, falls back to next provider.
   */
  async *chatStream(slot: ChatSlot, messages: ChatMessage[], opts: ChatOptions = {}): AsyncGenerator<string> {
    const providerIds = this.config.slots[slot];
    const attempts: CascadeAttempt[] = [];

    for (const id of providerIds) {
      const provider = this.providerMap.get(id)!;
      const breaker = this.getBreaker(id);

      if (breaker?.isOpen()) {
        attempts.push({ providerId: id, error: "circuit open" });
        continue;
      }

      const healthy = await this.checkProviderHealth(provider);
      if (!healthy) {
        attempts.push({ providerId: id, error: "health check failed" });
        console.log(`[registry] chatStream skip ${id} (unhealthy) for slot ${slot}`);
        continue;
      }

      try {
        const buffer: string[] = [];
        if (provider.type === "openai-compat") {
          const mergedOpts: ChatOptions = { timeoutMs: provider.timeoutMs, chunkTimeoutMs: provider.chunkTimeoutMs, ...opts };
          for await (const chunk of oaiClient.chatStream(provider.url!, provider.model, messages, mergedOpts)) {
            buffer.push(chunk);
          }
        } else {
          // Claude: claudeText is non-streaming, buffer the full result
          const prompt = messages.map(m => `${m.role}: ${m.content}`).join("\n\n");
          const result = await claudeText(prompt, { model: provider.model, timeoutMs: provider.timeoutMs });
          buffer.push(result);
        }

        // Provider committed cleanly — yield buffer to caller
        breaker?.recordSuccess();
        for (const chunk of buffer) yield chunk;
        return;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        breaker?.recordFailure();
        attempts.push({ providerId: id, error });
        console.log(`[registry] chatStream ${id} failed mid-stream (${error}), trying next for slot ${slot}`);
      }
    }

    throw new CascadeExhaustedError(slot, attempts);
  }

  /** Embed a single text using the configured embed provider. */
  async embed(text: string): Promise<number[]> {
    return (await this.embedBatch([text]))[0];
  }

  /** Embed multiple texts in one batch call. */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const embedId = this.config.slots.embed[0];
    const provider = this.providerMap.get(embedId)!;
    const timeoutMs = provider.timeoutMs ?? 15_000;
    try {
      return await oaiClient.embed(provider.url!, provider.model, texts, timeoutMs);
    } catch (err) {
      // Retry once with 2x timeout (mirrors old embed.ts resilience)
      console.warn(`[registry] embed failed, retrying: ${err}`);
      return oaiClient.embed(provider.url!, provider.model, texts, timeoutMs * 2);
    }
  }

  /** Health check all configured providers. */
  async health(): Promise<Record<string, { healthy: boolean; latencyMs?: number }>> {
    const results: Record<string, { healthy: boolean; latencyMs?: number }> = {};
    await Promise.all(
      this.config.providers.map(async p => {
        const start = Date.now();
        if (p.type === "claude") {
          results[p.id] = { healthy: true }; // Claude assumed present
        } else {
          const healthy = await oaiClient.health(p.url!);
          results[p.id] = { healthy, latencyMs: Date.now() - start };
        }
      })
    );
    return results;
  }
}
