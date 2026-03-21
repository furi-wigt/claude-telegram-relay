/**
 * Ollama module — centralized model registry and HTTP client.
 */
export { getModel, getEnvVar, ALL_PURPOSES, type OllamaPurpose } from "./models.ts";
export {
  getBaseUrl,
  callOllamaGenerate,
  summarizeMemoryItem,
  checkOllamaAvailable,
  ensureModel,
} from "./client.ts";
