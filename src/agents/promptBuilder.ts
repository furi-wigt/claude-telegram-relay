/**
 * Prompt Builder
 *
 * Constructs agent-specific prompts by combining the agent's system prompt
 * with user context, memory, and the incoming message.
 */

import type { AgentConfig } from "./config.ts";

export interface PromptContext {
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

  // User profile
  if (context.profileContext) {
    parts.push(`\nProfile:\n${context.profileContext}`);
  }

  // Memory context (facts, goals) - already filtered by chat_id
  if (context.memoryContext) {
    parts.push(`\n${context.memoryContext}`);
  }

  // Relevant past conversations - already filtered by chat_id
  if (context.relevantContext) {
    parts.push(`\n${context.relevantContext}`);
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
