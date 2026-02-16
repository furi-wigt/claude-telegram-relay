/**
 * Group Router
 *
 * Maps Telegram group chat IDs to specialized agents.
 * Supports both pre-configured mappings (via .env) and auto-discovery
 * based on group title matching.
 */

import type { Context } from "grammy";
import { AgentConfig, AGENTS } from "../agents/config.ts";

// Runtime mapping: chat ID -> agent config
const chatIdToAgent = new Map<number, AgentConfig>();

/**
 * Register a Telegram group chat ID to a specific agent.
 */
export function registerGroup(chatId: number, agentId: string): void {
  const agent = AGENTS[agentId];
  if (!agent) {
    console.error(`Unknown agent ID: ${agentId}`);
    return;
  }
  chatIdToAgent.set(chatId, agent);
  console.log(`Registered group ${chatId} -> ${agent.name}`);
}

/**
 * Get the agent assigned to a given chat ID.
 * Falls back to general-assistant for unregistered chats (including DMs).
 */
export function getAgentForChat(chatId: number): AgentConfig {
  return chatIdToAgent.get(chatId) || AGENTS["general-assistant"];
}

/**
 * Check if a chat ID is registered to an agent.
 */
export function isChatRegistered(chatId: number): boolean {
  return chatIdToAgent.has(chatId);
}

/**
 * Auto-discover and register a group based on its title.
 * Called as middleware on each incoming message.
 * Skips if the chat is already registered or is a private chat.
 */
export async function autoDiscoverGroup(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  // Skip if already registered
  if (chatIdToAgent.has(chatId)) return;

  // Skip private chats (DMs) - they use general-assistant by default
  if (ctx.chat?.type === "private") return;

  try {
    const chat = await ctx.getChat();
    const chatTitle = ("title" in chat ? chat.title : "") || "";

    if (!chatTitle) return;

    console.log(`Auto-discovering group: "${chatTitle}" (ID: ${chatId})`);

    // Try exact match first, then substring match
    for (const agent of Object.values(AGENTS)) {
      if (chatTitle === agent.groupName) {
        registerGroup(chatId, agent.id);
        return;
      }
    }

    // Substring match (group title contains agent group name)
    for (const agent of Object.values(AGENTS)) {
      if (chatTitle.includes(agent.groupName)) {
        registerGroup(chatId, agent.id);
        return;
      }
    }

    console.warn(
      `Could not auto-register group "${chatTitle}". ` +
        `Expected one of: ${Object.values(AGENTS).map((a) => a.groupName).join(", ")}`
    );
  } catch (error) {
    console.error("Auto-discovery failed:", error);
  }
}

/**
 * Load group mappings from environment variables.
 * Called once at startup.
 */
export function loadGroupMappings(): void {
  const mappings = [
    { envKey: "GROUP_AWS_CHAT_ID", agentId: "aws-architect" },
    { envKey: "GROUP_SECURITY_CHAT_ID", agentId: "security-analyst" },
    { envKey: "GROUP_DOCS_CHAT_ID", agentId: "documentation-specialist" },
    { envKey: "GROUP_CODE_CHAT_ID", agentId: "code-quality-coach" },
    { envKey: "GROUP_GENERAL_CHAT_ID", agentId: "general-assistant" },
  ];

  for (const { envKey, agentId } of mappings) {
    const chatId = process.env[envKey];
    if (chatId) {
      registerGroup(parseInt(chatId, 10), agentId);
    }
  }

  console.log(`Loaded ${chatIdToAgent.size} group mappings from environment`);
}

/**
 * Get a summary of all registered groups (for logging/debugging).
 */
export function getRegisteredGroups(): Array<{ chatId: number; agentName: string }> {
  const groups: Array<{ chatId: number; agentName: string }> = [];
  for (const [chatId, agent] of chatIdToAgent) {
    groups.push({ chatId, agentName: agent.name });
  }
  return groups;
}
