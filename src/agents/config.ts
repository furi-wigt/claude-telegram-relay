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

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { getUserPromptsDir, getRepoPromptsDir } from "../config/paths.ts";

const PROJECT_ROOT = join(dirname(dirname(dirname(import.meta.path))));

// ─── Types ────────────────────────────────────────────────────────────────────

/** Shape of each entry in config/agents.json */
interface AgentDefinition {
  id: string;
  name: string;
  groupName: string;
  shortName?: string;           // short display label for source labels (e.g. "General"); falls back to groupName
  groupKey?: string;            // uppercase key used in GROUPS map (e.g. "GENERAL", "AWS_ARCHITECT")
  chatId?: number;              // Telegram supergroup chat ID (negative number)
  topicId?: number | null;      // Forum topic thread ID; null = root chat / no topics
  claudeAgent?: string;         // optional Claude agent file reference
  capabilities: string[];
  isDefault?: boolean;          // exactly one agent should be marked as the DM/fallback default
  diagnostics?: { enabled: boolean }; // opt-in: use structured extraction prompts for images
  /** Default Claude model for this agent: "opus" | "sonnet" | "haiku" | "local". Overridden by user prefix. */
  defaultModel?: string;
}

/** Runtime agent config (prompt resolved, ready to use) */
export interface AgentConfig {
  id: string;
  name: string;
  groupName: string;
  shortName?: string;
  systemPrompt: string;
  claudeAgent?: string;
  capabilities: string[];
  groupKey?: string;
  chatId?: number;
  topicId?: number | null;
  diagnostics?: { enabled: boolean };
  /** Default Claude model for this agent: "opus" | "sonnet" | "haiku" | "local". Overridden by user prefix. */
  defaultModel?: string;
}

// ─── Loaders ─────────────────────────────────────────────────────────────────

function loadPrompt(agentId: string): string {
  const fileName = `${agentId}.md`;

  // 1. Try user-customised prompt (~/.claude-relay/prompts/<agentId>.md)
  const userPath = join(getUserPromptsDir(), fileName);
  if (existsSync(userPath)) {
    try {
      const content = readFileSync(userPath, "utf-8").trim();
      if (content.length > 0) return content;
    } catch {
      // unreadable — fall through to repo default
    }
  }

  // 2. Fall back to repo default (config/prompts/<agentId>.md)
  const repoPath = join(getRepoPromptsDir(), fileName);
  try {
    const content = readFileSync(repoPath, "utf-8").trim();
    if (content.length > 0) return content;
    console.warn(`[agents/config] ${agentId}.md is empty — using minimal fallback`);
  } catch {
    console.warn(`[agents/config] missing prompt for ${agentId} — using minimal fallback`);
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
    shortName: def.shortName,
    claudeAgent: def.claudeAgent,
    capabilities: def.capabilities,
    groupKey: def.groupKey,
    chatId: def.chatId,
    topicId: def.topicId,
    systemPrompt: loadPrompt(def.id),
    diagnostics: def.diagnostics,
    defaultModel: def.defaultModel,
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
