// src/models/index.ts
// Process-scoped ModelRegistry singleton.
// Call initRegistry() once at startup before any other model operations.

import { ModelRegistry } from "./registry.ts";
import { join } from "path";
import { homedir } from "os";

let _registry: ModelRegistry | null = null;

/** Initialize the registry from ~/.claude-relay/models.json. Call once at startup. */
export function initRegistry(configPath?: string): ModelRegistry {
  const path = configPath ?? join(homedir(), ".claude-relay", "models.json");
  _registry = ModelRegistry.load(path);
  const suffix = _registry.embedCollectionSuffix();
  console.log(`[ModelRegistry] loaded — embed suffix: ${suffix}`);
  return _registry;
}

/** Get the initialized registry. Throws if initRegistry() was not called. */
export function getRegistry(): ModelRegistry {
  if (!_registry) throw new Error("ModelRegistry not initialized — call initRegistry() at startup first");
  return _registry;
}

/**
 * FOR TESTS ONLY — inject a pre-built registry instance as the singleton.
 * Do not use in production code.
 */
export function _testSetRegistry(r: ModelRegistry): void {
  _registry = r;
}

export { ModelRegistry } from "./registry.ts";
export type { ChatSlot, ChatMessage, ChatOptions } from "./types.ts";
