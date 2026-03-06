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
  /** Unique document titles that contributed to documentContext — used for transparency footer */
  documentTitles?: string[];
  /** Vision analysis from Anthropic SDK for images sent in Telegram */
  imageContext?: string;
  /** Structured domain-specific extraction for diagnostic agents (aws-architect, security-analyst, code-quality-coach) */
  diagnosticContext?: string;
  /**
   * Most recent routine message Claude has not seen in the current context window.
   * Injected when --resume is active and the last assistant turn the user saw was a routine.
   */
  routineContext?: string;
  /**
   * When true, the Claude session is being resumed via --resume and already has the
   * system prompt in its context window. Skip static parts (agent identity, userName)
   * to avoid redundant accumulation across turns. Dynamic parts (time, memory, message)
   * are always included.
   */
  isResumedSession?: boolean;
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
  const resumed = context.isResumedSession === true;

  // Static parts: only on fresh sessions. On resumed sessions Claude already has
  // these in its context window from turn 1 — repeating them causes accumulation.
  if (!resumed) {
    parts.push(agent.systemPrompt);
    if (context.userName) {
      parts.push(`You are speaking with ${context.userName}.`);
    }
  }

  // Current time — always included (changes every call)
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

  // Routine context — the last proactive message the user saw that Claude has not received.
  // Only present on resumed sessions where the last assistant turn was a routine message.
  if (context.routineContext) {
    parts.push(`\n<routine_context>\n${context.routineContext}\n</routine_context>`);
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
    // KB transparency footer instruction — Claude appends this when it uses document context
    const titles = context.documentTitles?.length
      ? context.documentTitles.map((t) => `"${t}"`).join(", ")
      : "the relevant document";
    parts.push(
      `\n<kb_footer_instruction>\nIf your response draws on the document context above, end your reply with exactly this line (no extra newlines before it):\n📄 _Based on: ${titles}_\n</kb_footer_instruction>`
    );
  }

  // Vision analysis — injected when user sends a photo (generic vision)
  if (context.imageContext) {
    parts.push(`\n<image_analysis>\n${context.imageContext}\n</image_analysis>`);
  }

  // Diagnostic image extraction — structured domain-specific data for specialist agents
  if (context.diagnosticContext) {
    parts.push(`\n<diagnostic_image>\n${context.diagnosticContext}\n</diagnostic_image>`);
  }

  // Memory management instructions
  parts.push(
    "\n<memory_management>" +
      "\nWhen the user shares something worth remembering, sets goals, or completes goals, " +
      "include these tags in your response (they are processed automatically and hidden from the user):" +
      "\n[REMEMBER: fact to store]" +
      "\n[GOAL: goal text | DEADLINE: optional date]" +
      "\n[DONE: search text for completed goal]" +
      "\n[NEXT: one concise recommended next step or action for the user]" +
      "\n</memory_management>"
  );

  // The actual user message
  parts.push(`\nUser: ${userMessage}`);

  return parts.join("\n");
}
