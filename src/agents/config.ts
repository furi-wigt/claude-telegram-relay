/**
 * Agent Configuration
 *
 * Agents are defined in agents.json (metadata) and prompts/<id>.md (system prompts).
 * Both are loaded once at startup — no file I/O on each message.
 *
 * agents.json load order (first found wins):
 *   1. RELAY_AGENTS_PATH env var    — system/CI override (absolute path)
 *   2. ~/.claude-relay/agents.json  — user runtime config (chatIds, topicIds)
 *   3. config/agents.json           — repo gitignored copy (legacy / local dev)
 *   4. config/agents.example.json   — committed template (fresh clone fallback)
 *
 * To add, remove, or rename a specialist:
 *   1. Edit ~/.claude-relay/agents.json (or config/agents.json for dev)
 *   2. Add/remove the matching config/prompts/<id>.md
 *   3. Restart the service
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import {
  getUserPromptsDir,
  getRepoPromptsDir,
  getSystemAgentsPath,
  getUserAgentsPath,
  getRepoAgentsPath,
  getRepoAgentsExamplePath,
} from "../config/paths.ts";

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
  // ── Mesh contract fields (optional, for constrained mesh orchestration) ──
  /** Agent IDs this agent may communicate with directly (bypassing blackboard) */
  meshPeers?: string[];
  /** Preconditions that must be met before this agent can be triggered */
  preconditions?: string[];
  /** Risk level of this agent's output — drives review requirements */
  riskLevel?: "low" | "medium" | "high" | "critical";
  /** Whether artifacts from this agent require reviewer approval */
  reviewRequired?: boolean;
  /** Dedicated forum topic ID for receiving direct mesh messages from other agents */
  meshTopicId?: number | null;
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
  // ── Mesh contract fields ──
  meshPeers?: string[];
  preconditions?: string[];
  riskLevel?: "low" | "medium" | "high" | "critical";
  reviewRequired?: boolean;
  /** Dedicated forum topic ID for receiving direct mesh messages from other agents */
  meshTopicId?: number | null;
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

// ─── Resolve agents.json path (4-tier: system env → user → repo → example) ───

function resolveAgentsPath(): string {
  // 1. system env — RELAY_AGENTS_PATH (CI, Docker, explicit override)
  const sys = getSystemAgentsPath();
  if (sys && existsSync(sys)) return sys;

  // 2. user env — ~/.claude-relay/agents.json
  const user = getUserAgentsPath();
  if (existsSync(user)) return user;

  // 3. project env — config/agents.json (gitignored dev copy)
  const repo = getRepoAgentsPath();
  if (existsSync(repo)) return repo;

  // 4. project env fallback — config/agents.example.json (fresh clone)
  return getRepoAgentsExamplePath();
}

// ─── Build AGENTS ─────────────────────────────────────────────────────────────

const agentsPath = resolveAgentsPath();
console.log(`[agents/config] loading from ${agentsPath.replace(process.env.HOME || "", "~")}`);
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
    meshPeers: def.meshPeers,
    preconditions: def.preconditions,
    riskLevel: def.riskLevel,
    reviewRequired: def.reviewRequired,
    meshTopicId: def.meshTopicId,
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
