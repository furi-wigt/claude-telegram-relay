/**
 * Scans .claude/todos/*.md across registered project directories for
 * E2E test checklist sections with unchecked items (- [ ]).
 *
 * Project directories are dynamically registered via chat context
 * and persisted in sessions/e2e-watch-dirs.json.
 */

import { readdir, readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";

export interface PendingE2EItem {
  step: string;
  expected: string;
}

export interface PendingE2EScenario {
  heading: string;
  items: PendingE2EItem[];
}

export interface PendingE2ETodo {
  file: string;
  feature: string;
  project: string; // human-readable project name
  scenarios: PendingE2EScenario[];
  totalPending: number;
  /** e.g. "prod-bot | Code Quality > context-loss" — from e2e-env frontmatter */
  env?: string;
  /** e.g. "run /new first" — from e2e-pre frontmatter */
  pre?: string;
}

export interface WatchedProject {
  name: string; // e.g. "Relay", "ReportGen"
  path: string; // absolute path to project root
}

// ── Registry ──────────────────────────────────────────────────────────────────

const DEFAULT_REGISTRY_PATH = join(
  import.meta.dir,
  "../../sessions/e2e-watch-dirs.json"
);

export async function loadWatchedProjects(
  registryPath?: string
): Promise<WatchedProject[]> {
  const file = registryPath ?? DEFAULT_REGISTRY_PATH;
  try {
    const raw = await readFile(file, "utf-8");
    return JSON.parse(raw) as WatchedProject[];
  } catch {
    return [];
  }
}

export async function saveWatchedProjects(
  projects: WatchedProject[],
  registryPath?: string
): Promise<void> {
  const file = registryPath ?? DEFAULT_REGISTRY_PATH;
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, JSON.stringify(projects, null, 2) + "\n");
}

export async function addWatchedProject(
  project: WatchedProject,
  registryPath?: string
): Promise<void> {
  const projects = await loadWatchedProjects(registryPath);
  const exists = projects.some((p) => p.path === project.path);
  if (exists) return;
  projects.push(project);
  await saveWatchedProjects(projects, registryPath);
}

export async function removeWatchedProject(
  projectPath: string,
  registryPath?: string
): Promise<void> {
  const projects = await loadWatchedProjects(registryPath);
  const filtered = projects.filter((p) => p.path !== projectPath);
  if (filtered.length !== projects.length) {
    await saveWatchedProjects(filtered, registryPath);
  }
}

// ── Parsing ───────────────────────────────────────────────────────────────────

/**
 * Parse a kebab-case filename into a human-readable feature name.
 * "260312_233300_ltm-overhaul.md" → "Ltm Overhaul"
 */
export function filenameToFeature(filename: string): string {
  return filename
    .replace(/^\d{6}_\d{6}_/, "")
    .replace(/\.md$/, "")
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Parse YAML-like frontmatter block (---\n...\n---) from markdown content.
 * Returns a flat key→value map for known e2e-* keys.
 */
export function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.+)/);
    if (kv) result[kv[1]] = kv[2].trim();
  }
  return result;
}

/**
 * Match flexible E2E section headers:
 * - "## User E2E Test Checklist"
 * - "## E2E Test Checklist"
 * - "## Manual E2E Tests"
 * - "### E2E Tests"
 * - Any heading containing "E2E" + ("test" or "checklist")
 */
const E2E_HEADER_RE = /^(#{1,5})\s+.*E2E.*(?:test|checklist)/im;

/**
 * Extract pending E2E test items from a single markdown file's content.
 */
export function extractPendingE2E(content: string): PendingE2EScenario[] {
  const sectionMatch = content.match(E2E_HEADER_RE);
  if (!sectionMatch || sectionMatch.index === undefined) return [];

  const sectionStart = sectionMatch.index;
  const headerLevel = sectionMatch[1].length;
  const headerPattern = new RegExp(
    `^#{1,${headerLevel}}\\s+(?!.*E2E)`,
    "m"
  );
  const rest = content.slice(sectionStart + sectionMatch[0].length);
  const nextSection = rest.search(headerPattern);
  const sectionBody =
    nextSection === -1 ? rest : rest.slice(0, nextSection);

  const scenarios: PendingE2EScenario[] = [];
  let currentScenario: PendingE2EScenario | null = null;

  for (const line of sectionBody.split("\n")) {
    // Scenario heading
    const scenarioMatch = line.match(/^#{2,5}\s+(?:Scenario[:\s]*)?(.+)/i);
    if (scenarioMatch && !line.match(/E2E.*(?:test|checklist)/i)) {
      if (currentScenario && currentScenario.items.length > 0) {
        scenarios.push(currentScenario);
      }
      currentScenario = {
        heading: scenarioMatch[1].trim(),
        items: [],
      };
      continue;
    }

    // Unchecked item: "- [ ] ..."
    if (line.match(/^[\s]*-\s+\[\s\]/)) {
      const cleaned = line
        .replace(/^[\s]*-\s+\[\s\]\s*/, "")
        .replace(/\*\*/g, "");

      const parts = cleaned.split(
        /\s*[→⟶]\s*Expected:\s*|\s*→\s*|\s*Expected:\s*/i
      );
      const step = parts[0].trim();
      const expected = parts[1]?.trim() ?? "";

      if (!currentScenario) {
        currentScenario = { heading: "General", items: [] };
      }
      currentScenario.items.push({ step, expected });
    }
  }

  if (currentScenario && currentScenario.items.length > 0) {
    scenarios.push(currentScenario);
  }

  return scenarios;
}

// ── Scanning ──────────────────────────────────────────────────────────────────

/**
 * Scan a single todos directory for pending E2E tests.
 * Returns [] if the directory does not exist.
 */
async function scanDir(
  todosDir: string,
  projectName: string
): Promise<PendingE2ETodo[]> {
  let files: string[];
  try {
    files = await readdir(todosDir);
  } catch {
    return [];
  }

  const mdFiles = files.filter((f) => f.endsWith(".md")).sort().reverse();

  const settled = await Promise.allSettled(
    mdFiles.map(async (file) => {
      const content = await readFile(join(todosDir, file), "utf-8");
      const scenarios = extractPendingE2E(content);
      if (scenarios.length === 0) return null;
      const totalPending = scenarios.reduce(
        (sum, s) => sum + s.items.length,
        0
      );
      const fm = parseFrontmatter(content);
      const env = fm["e2e-env"];
      const pre = fm["e2e-pre"];
      return { file, feature: filenameToFeature(file), project: projectName, scenarios, totalPending, ...(env && { env }), ...(pre && { pre }) };
    })
  );

  return settled
    .filter((r): r is PromiseFulfilledResult<PendingE2ETodo> =>
      r.status === "fulfilled" && r.value !== null
    )
    .map((r) => r.value);
}

/**
 * Scan all registered project directories for pending E2E tests.
 * Always includes the relay project itself, plus any registered projects.
 */
export async function scanPendingE2ETests(
  todosDir?: string,
  registryPath?: string
): Promise<PendingE2ETodo[]> {
  const relayDir =
    todosDir ??
    join(process.env.PROJECT_DIR || process.cwd(), ".claude/todos");

  const watched = await loadWatchedProjects(registryPath);

  const [relayResults, ...watchedResults] = await Promise.all([
    scanDir(relayDir, "Relay"),
    ...watched.map((p) => scanDir(join(p.path, ".claude/todos"), p.name)),
  ]);

  const results = [
    ...relayResults,
    ...watchedResults.flat(),
  ];

  results.sort((a, b) => b.totalPending - a.totalPending);
  return results;
}

// ── Formatting ────────────────────────────────────────────────────────────────

/**
 * Render a single todo's scenarios into lines.
 * indent: prefix for feature/scenario/item lines (e.g. "  " for multi-project)
 * maxItems: max unchecked items to show per scenario before truncating
 */
function renderTodo(
  todo: PendingE2ETodo,
  lines: string[],
  indent: string,
  maxItems: number
): void {
  lines.push(`${indent}**${todo.feature}** (${todo.totalPending} steps)`);
  if (todo.env || todo.pre) {
    const envPart = todo.env ? `Env: ${todo.env}` : "";
    const prePart = todo.pre ? `Pre: ${todo.pre}` : "";
    lines.push(`${indent}_${[envPart, prePart].filter(Boolean).join(" | ")}_`);
  }
  for (const scenario of todo.scenarios) {
    if (scenario.heading !== "General") {
      lines.push(`${indent}_${scenario.heading}_`);
    }
    for (const item of scenario.items.slice(0, maxItems)) {
      const expected = item.expected ? ` → ${item.expected}` : "";
      lines.push(`${indent}• ${item.step}${expected}`);
    }
    if (scenario.items.length > maxItems) {
      lines.push(
        `${indent}  _…and ${scenario.items.length - maxItems} more steps_`
      );
    }
  }
  lines.push("");
}

/**
 * Format pending E2E tests for the morning summary.
 * Groups by project when multiple projects have pending tests.
 */
export function formatPendingE2ESection(todos: PendingE2ETodo[]): string {
  if (todos.length === 0) return "";

  const totalItems = todos.reduce((sum, t) => sum + t.totalPending, 0);
  const projects = [...new Set(todos.map((t) => t.project))];
  const multiProject = projects.length > 1;
  const lines: string[] = [];

  lines.push(
    `🧪 **Pending E2E Tests** (${totalItems} steps across ${todos.length} features)`
  );
  lines.push("");

  if (multiProject) {
    for (const project of projects) {
      const projectTodos = todos.filter((t) => t.project === project);
      const projectTotal = projectTodos.reduce(
        (sum, t) => sum + t.totalPending,
        0
      );
      lines.push(`📁 **${project}** (${projectTotal} steps)`);
      for (const todo of projectTodos) {
        renderTodo(todo, lines, "  ", 2);
      }
    }
  } else {
    for (const todo of todos) {
      renderTodo(todo, lines, "", 3);
    }
  }

  lines.push(
    `_Reply "run e2e" to get the full step-by-step checklist for the top feature._`
  );

  return lines.join("\n");
}
