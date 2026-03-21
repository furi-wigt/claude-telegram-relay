/**
 * Generates short topic labels (3-7 words) for messages using local Ollama.
 */
import { callOllamaGenerate } from "../ollama/client.ts";

const TOPIC_TIMEOUT_MS = 3_000;
const MIN_CONTENT_LENGTH = 50;
const MAX_PROMPT_INPUT = 500;

/**
 * Generate a 3-7 word topic label for a message.
 * - Content < 50 chars: return first 50 chars directly (no LLM call)
 * - Ollama timeout/failure: return first 60 chars as fallback
 */
export async function generateTopic(content: string): Promise<string> {
  if (content.length < MIN_CONTENT_LENGTH) {
    return content.slice(0, 50).trim();
  }

  try {
    const truncated = content.slice(0, MAX_PROMPT_INPUT);
    const result = await callOllamaGenerate(
      `Summarize this message in 3-7 words as a topic label. Plain text only, no quotes, no punctuation at end:\n\n${truncated}`,
      { purpose: "topic-generation", timeoutMs: TOPIC_TIMEOUT_MS }
    );
    // Validate: should be short. If LLM returned garbage, fallback.
    const cleaned = result.replace(/^["']|["']$/g, "").trim();
    if (cleaned.length > 0 && cleaned.split(/\s+/).length <= 10) {
      return cleaned;
    }
    return content.slice(0, 60).trim();
  } catch {
    return content.slice(0, 60).trim();
  }
}
