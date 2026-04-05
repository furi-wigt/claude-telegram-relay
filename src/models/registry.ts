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

  // chatStream(), embed(), embedBatch(), health() added in Tasks 6-7
}
