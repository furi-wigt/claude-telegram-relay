// src/models/registry.ts
import { readFileSync } from "fs";
import { ModelsConfigSchema } from "./schema.ts";
import { CircuitBreaker } from "./circuitBreaker.ts";
import {
  type ModelsConfig,
  type ProviderConfig,
  ModelConfigError,
} from "./types.ts";

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

  // chat(), chatStream(), embed(), embedBatch(), health() added in Tasks 5-7
}
