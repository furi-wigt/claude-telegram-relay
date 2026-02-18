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
    parts.push(`\n═══ USER PROFILE ═══\n${context.userProfile}`);
  } else if (context.profileContext) {
    parts.push(`\n═══ USER PROFILE ═══\n${context.profileContext}`);
  }

  // Conversation history (short-term: summaries + last N verbatim messages)
  if (context.shortTermContext) {
    parts.push(`\n═══ CONVERSATION HISTORY ═══\n${context.shortTermContext}`);
  }

  // Memory context (facts, goals) - already filtered by chat_id
  if (context.memoryContext) {
    parts.push(`\n${context.memoryContext}`);
  }

  // Relevant past conversations - semantic search results
  if (context.relevantContext) {
    parts.push(`\n═══ RELEVANT CONTEXT ═══\n${context.relevantContext}`);
  }

  // Memory management instructions
  parts.push(
    "\nMEMORY MANAGEMENT:" +
      "\nWhen the user shares something worth remembering, sets goals, or completes goals, " +
      "include these tags in your response (they are processed automatically and hidden from the user):" +
      "\n[REMEMBER: fact to store]" +
      "\n[GOAL: goal text | DEADLINE: optional date]" +
      "\n[DONE: search text for completed goal]"
  );

  // The actual user message
  parts.push(`\nUser: ${userMessage}`);

  return parts.join("\n");
}
