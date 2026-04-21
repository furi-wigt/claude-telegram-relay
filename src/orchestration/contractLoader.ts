/**
 * Contract Loader
 *
 * Loads NLAH task contracts from ~/.claude-relay/contracts/<intent>.md
 * Falls back to default.md when no specific contract matches.
 */

import { readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

export interface ContractStep {
  seq: number;
  /** Agent ID to dispatch this step to */
  agent: string;
  /** What to instruct the agent — injected into the dispatch message */
  instruction: string;
}

export interface Contract {
  /** File name without extension */
  name: string;
  intent: string;
  agents: string[];
  steps: ContractStep[];
  maxLoopIterations?: number;
  contextInjection?: string;
  output?: string;
}

const CONTRACTS_DIR = join(homedir(), ".claude-relay", "contracts");

/**
 * Load the contract for a given intent string.
 * Returns null only if both the intent file AND default.md are missing.
 */
export async function loadContract(intent: string): Promise<Contract | null> {
  const specific = await readContractFile(intentToFileName(intent));
  if (specific) return specific;
  return readContractFile("default.md");
}

// ── Internals ─────────────────────────────────────────────────────────────────

async function readContractFile(fileName: string): Promise<Contract | null> {
  try {
    const content = await readFile(join(CONTRACTS_DIR, fileName), "utf-8");
    return parseContract(content, fileName);
  } catch {
    return null;
  }
}

function intentToFileName(intent: string): string {
  return intent.toLowerCase().replace(/_/g, "-").replace(/\s+/g, "-") + ".md";
}

function parseContract(content: string, fileName: string): Contract {
  const frontmatter = parseFrontmatter(content);
  const steps = parseSteps(content);
  const agentsFromFrontmatter = frontmatter["agents"]
    ? parseArray(frontmatter["agents"])
    : steps.map((s) => s.agent);

  const rawMaxLoop = frontmatter["max_loop_iterations"] ?? frontmatter["maxLoopIterations"];
  return {
    name: fileName.replace(/\.md$/, ""),
    intent: frontmatter["intent"] ?? fileName.replace(/\.md$/, ""),
    agents: agentsFromFrontmatter,
    steps,
    maxLoopIterations: rawMaxLoop ? parseInt(rawMaxLoop, 10) : undefined,
    contextInjection: frontmatter["context-injection"] ?? frontmatter["contextInjection"],
    output: frontmatter["output"],
  };
}

/** Parse YAML-like frontmatter between leading --- delimiters */
function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]+?)\r?\n---/);
  if (!match) return {};

  const result: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

/** Parse inline array: "[a, b, c]" → ["a", "b", "c"] */
function parseArray(value: string): string[] {
  const inner = value.replace(/^\[|\]$/g, "").trim();
  if (!inner) return [];
  return inner.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Parse numbered steps from the ## Steps section.
 * Supports two formats:
 *   1. **agent-id** — instruction text
 *   1. agent-id: instruction text
 */
function parseSteps(content: string): ContractStep[] {
  const sectionMatch = content.match(/##\s+Steps?\r?\n([\s\S]+?)(?:\n##\s|\s*$)/);
  if (!sectionMatch) return [];

  const steps: ContractStep[] = [];
  let seq = 1;

  for (const line of sectionMatch[1].split("\n")) {
    const bold = line.match(/^\d+\.\s+\*\*(.+?)\*\*\s+[—\-]\s+(.+)/);
    const plain = line.match(/^\d+\.\s+(.+?):\s+(.+)/);
    const match = bold ?? plain;
    if (match) {
      steps.push({ seq: seq++, agent: match[1].trim(), instruction: match[2].trim() });
    }
  }

  return steps;
}
