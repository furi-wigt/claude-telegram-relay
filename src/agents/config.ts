/**
 * Agent Configuration
 *
 * Agents are defined entirely in config/agents.json (metadata) and
 * config/prompts/<agent-id>.md (system prompts). Both files are loaded
 * once at startup — no file I/O on each message.
 *
 * To add, remove, or rename a specialist:
 *   1. Edit config/agents.json
 *   2. Add/remove the matching config/prompts/<id>.md
 *   3. Restart the service
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";

const PROJECT_ROOT = join(dirname(dirname(dirname(import.meta.path))));

// ─── Types ────────────────────────────────────────────────────────────────────

/** Shape of each entry in config/agents.json */
interface AgentDefinition {
  id: string;
  name: string;
  groupName: string;
  groupKey?: string;            // uppercase key used in GROUPS map (e.g. "GENERAL", "AWS_ARCHITECT")
  chatId?: number;              // Telegram supergroup chat ID (negative number)
  topicId?: number | null;      // Forum topic thread ID; null = root chat / no topics
  codingTopicId?: number;       // Forum topic ID for /code session progress updates
  claudeAgent?: string;         // optional Claude agent file reference
  capabilities: string[];
  isDefault?: boolean;          // exactly one agent should be marked as the DM/fallback default
  diagnostics?: { enabled: boolean }; // opt-in: use structured extraction prompts for images
}

/** Runtime agent config (prompt resolved, ready to use) */
export interface AgentConfig {
  id: string;
  name: string;
  groupName: string;
  systemPrompt: string;
  claudeAgent?: string;
  capabilities: string[];
  groupKey?: string;
  chatId?: number;
  topicId?: number | null;
  codingTopicId?: number;
  diagnostics?: { enabled: boolean };
}

// ─── Loaders ─────────────────────────────────────────────────────────────────

function loadPrompt(agentId: string): string {
  const promptPath = join(PROJECT_ROOT, "config", "prompts", `${agentId}.md`);
  try {
    const content = readFileSync(promptPath, "utf-8").trim();
    if (content.length > 0) return content;
    console.warn(`[agents/config] ${agentId}.md is empty — using minimal fallback`);
  } catch {
    console.warn(`[agents/config] missing ${promptPath} — using minimal fallback`);
  }
  return `You are a helpful AI assistant (${agentId}).`;
}

// ─── Build AGENTS from config/agents.json ────────────────────────────────────

const agentsPath = join(PROJECT_ROOT, "config", "agents.json");
const agentDefs: AgentDefinition[] = JSON.parse(readFileSync(agentsPath, "utf-8"));

export const AGENTS: Record<string, AgentConfig> = {};

for (const def of agentDefs) {
  AGENTS[def.id] = {
    id: def.id,
    name: def.name,
    groupName: def.groupName,
    claudeAgent: def.claudeAgent,
    capabilities: def.capabilities,
    groupKey: def.groupKey,
    chatId: def.chatId,
    topicId: def.topicId,
    codingTopicId: def.codingTopicId,
    systemPrompt: loadPrompt(def.id),
    diagnostics: def.diagnostics,
  };
}

/** Default agent for DMs and unregistered groups — marked isDefault in agents.json */
export const DEFAULT_AGENT: AgentConfig =
  AGENTS[(agentDefs.find((d) => d.isDefault) ?? agentDefs[0]).id];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Get an agent by ID. Falls back to DEFAULT_AGENT if not found. */
export function getAgent(agentId: string): AgentConfig {
  return AGENTS[agentId] ?? DEFAULT_AGENT;
}

/** Get all agent IDs. */
export function getAgentIds(): string[] {
  return Object.keys(AGENTS);
}
