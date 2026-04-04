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
  /** Blackboard evidence and decisions from the active orchestration session */
  blackboardContext?: string;
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

  // Always inject system prompt — Claude's --resume can silently fail,
  // so we cannot trust that the original prompt is still in its context window.
  parts.push(agent.systemPrompt);
  if (context.userName) {
    parts.push(`You are speaking with ${context.userName}.`);
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

  // Blackboard context — evidence and decisions from active orchestration session
  if (context.blackboardContext) {
    parts.push(`\n<blackboard_context>\n${context.blackboardContext}\n</blackboard_context>`);
    // Orchestration tag instructions — only when agent is in a board session
    parts.push(
      "\n<orchestration_tags>" +
        "\nYou are part of a multi-agent orchestration session. Use these tags to coordinate:" +
        "\n[BOARD: finding] <text> — post evidence or a finding to the shared board" +
        "\n[BOARD: artifact] <text> — post a deliverable (code, doc, report)" +
        "\n[BOARD: decision] <text> — record a decision with rationale" +
        "\n[ASK_AGENT: <agent-id>] <question> — ask a peer agent directly (only whitelisted pairs)" +
        "\n[BOARD_SUMMARY: <text>] — post a brief status update" +
        "\n[CONFIDENCE: <0-1>] — self-assess confidence in your output" +
        "\n[DONE_TASK: <seq>] — mark your assigned task as complete" +
        "\n</orchestration_tags>"
    );
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

  // Token budget guard: trim low-priority context if prompt is too large
  trimContextParts(parts, 20_000);

  return parts.join("\n");
}

/**
 * Trim low-priority context blocks when total character count exceeds maxChars.
 * Removal priority (lowest value = removed first):
 *   1. <document_context> and <kb_footer_instruction>
 *   2. <relevant_context>
 *   3. <conversation_history> — truncated to first 500 chars (not removed)
 * Mutates the array in place.
 */
function trimContextParts(parts: string[], maxChars: number): void {
  let running = parts.reduce((sum, p) => sum + p.length, 0);

  if (running <= maxChars) return;

  // Priority 1: remove document context + kb footer
  for (let i = parts.length - 1; i >= 0; i--) {
    if (
      parts[i].includes("<document_context>") ||
      parts[i].includes("<kb_footer_instruction>")
    ) {
      running -= parts[i].length;
      parts.splice(i, 1);
    }
  }
  if (running <= maxChars) return;

  // Priority 1.5: remove blackboard context
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].includes("<blackboard_context>")) {
      running -= parts[i].length;
      parts.splice(i, 1);
    }
  }
  if (running <= maxChars) return;

  // Priority 2: remove relevant context
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].includes("<relevant_context>")) {
      running -= parts[i].length;
      parts.splice(i, 1);
    }
  }
  if (running <= maxChars) return;

  // Priority 3: truncate conversation history to last 2000 chars (keep recent, drop oldest)
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].includes("<conversation_history>")) {
      const tag = "<conversation_history>";
      const closeTag = "</conversation_history>";
      const content = parts[i];
      const tagStart = content.indexOf(tag);
      const inner = content.slice(tagStart + tag.length, content.indexOf(closeTag));
      const kept = inner.length > 2000
        ? inner.slice(-2000)
        : inner;
      const truncated =
        content.slice(0, tagStart + tag.length) +
        (inner.length > 2000 ? "\n[...older messages truncated]\n" : "") +
        kept +
        "\n" + closeTag;
      parts[i] = truncated;
    }
  }
}
