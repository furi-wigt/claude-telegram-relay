/**
 * Prompt Builder
 *
 * Constructs agent-specific prompts by combining the agent's system prompt
 * with user context, memory, and the incoming message.
 */

import type { AgentConfig } from "./config.ts";

export interface PromptContext {
  shortTermContext?: string;
  userProfile?: string;
  relevantContext?: string;
  memoryContext?: string;
  profileContext?: string;
  userName?: string;
  timeStr: string;
  /** Injected document chunks from RAG (insurance policies, etc.) */
  documentContext?: string;
  /** Vision analysis from Anthropic SDK for images sent in Telegram */
  imageContext?: string;
}

/**
 * Build a complete prompt for a specific agent.
 * Combines agent system prompt + user context + memory + message.
 */
export function buildAgentPrompt(
  agent: AgentConfig,
  userMessage: string,
  context: PromptContext
): string {
  const parts: string[] = [];

  // Agent identity and system prompt
  parts.push(agent.systemPrompt);

  // User identity
  if (context.userName) {
    parts.push(`You are speaking with ${context.userName}.`);
  }

  // Current time
  parts.push(`Current time: ${context.timeStr}`);

  // User profile (extracted long-term profile takes precedence over static profile.md)
  if (context.userProfile) {
    parts.push(`\n<user_profile>\n${context.userProfile}\n</user_profile>`);
  } else if (context.profileContext) {
    parts.push(`\n<user_profile>\n${context.profileContext}\n</user_profile>`);
  }

  // Conversation history (short-term: summaries + last N verbatim messages)
  if (context.shortTermContext) {
    parts.push(`\n<conversation_history>\n${context.shortTermContext}\n</conversation_history>`);
  }

  // Memory context (facts, goals) - already filtered by chat_id
  if (context.memoryContext) {
    parts.push(`\n<memory>\n${context.memoryContext}\n</memory>`);
  }

  // Relevant past conversations - semantic search results
  if (context.relevantContext) {
    parts.push(`\n<relevant_context>\n${context.relevantContext}\n</relevant_context>`);
  }

  // Document RAG context (insurance policies, etc.)
  if (context.documentContext) {
    parts.push(`\n<document_context>\n${context.documentContext}\n</document_context>`);
  }

  // Vision analysis — injected when user sends a photo
  if (context.imageContext) {
    parts.push(`\n<image_analysis>\n${context.imageContext}\n</image_analysis>`);
  }

  // Memory management instructions
  parts.push(
    "\n<memory_management>" +
      "\nWhen the user shares something worth remembering, sets goals, or completes goals, " +
      "include these tags in your response (they are processed automatically and hidden from the user):" +
      "\n[REMEMBER: fact to store]" +
      "\n[GOAL: goal text | DEADLINE: optional date]" +
      "\n[DONE: search text for completed goal]" +
      "\n</memory_management>"
  );

  // The actual user message
  parts.push(`\nUser: ${userMessage}`);

  return parts.join("\n");
}
