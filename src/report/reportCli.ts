/**
 * Thin wrapper around the Report_Generator CLI.
 *
 * All functions spawn `bun run src/cli.ts` inside REPORT_GEN_DIR and parse stdout.
 * Override the generator path via REPORT_GEN_DIR env var.
 */

import { spawn } from "bun";
import { join } from "path";

// Path to Report_Generator CLI — override via env var
const REPORT_GEN_DIR =
  process.env.REPORT_GEN_DIR ??
  "/Users/furi/Documents/WorkInGovTech/01_Projects/Tools/Report_Generator";

const CLI_ENTRY = join(REPORT_GEN_DIR, "src", "cli.ts");

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface CliResult {
  stdout: string;
  stderr: string;
  ok: boolean;
  exitCode: number;
}

// ──────────────────────────────────────────────
// Core runner
// ──────────────────────────────────────────────

export async function runReportCli(
  args: string[],
  opts?: { timeout?: number }
): Promise<CliResult> {
  const timeout = opts?.timeout ?? DEFAULT_TIMEOUT_MS;

  const proc = spawn(["bun", "run", CLI_ENTRY, ...args], {
    cwd: REPORT_GEN_DIR,
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeoutPromise: Promise<CliResult> = new Promise((resolve) => {
    setTimeout(() => {
      proc.kill();
      resolve({ ok: false, exitCode: -1, stdout: "", stderr: "timeout" });
    }, timeout);
  });

  const runPromise: Promise<CliResult> = (async () => {
    const [stdoutBuf, stderrBuf] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return {
      stdout: stdoutBuf,
      stderr: stderrBuf,
      ok: exitCode === 0,
      exitCode,
    };
  })();

  return Promise.race([runPromise, timeoutPromise]);
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function topicToKebab(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function slugWords(slug: string): string[] {
  return slug.split("-").filter(Boolean);
}

// ──────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────

export async function listSlugs(project?: string): Promise<string[]> {
  const args = ["report", "list", "--json"];
  if (project) args.push("--project", project);

  const result = await runReportCli(args);
  if (!result.ok) return [];

  try {
    const parsed = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item: { slug: string }) => item.slug).filter(Boolean);
  } catch {
    return [];
  }
}

export async function listProjects(): Promise<string[]> {
  const result = await runReportCli(["report", "project", "list", "--json"]);
  if (!result.ok) return [];

  try {
    const parsed = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item: { name: string }) => item.name).filter(Boolean);
  } catch {
    return [];
  }
}

export async function slugExists(slug: string, project?: string): Promise<boolean> {
  const slugs = await listSlugs(project);
  return slugs.includes(slug);
}

export async function findSimilarSlugs(topic: string, project?: string): Promise<string[]> {
  const kebab = topicToKebab(topic);
  const topicWords = new Set(slugWords(kebab));

  const slugs = await listSlugs(project);

  const matches = slugs.filter((slug) => {
    const words = slugWords(slug);
    const shared = words.filter((w) => topicWords.has(w));
    return shared.length >= 2;
  });

  return matches.slice(0, 3);
}
