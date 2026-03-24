/**
 * Manifest Reader
 *
 * Reads Report Generator manifest files and resolves paths.
 *
 * Report Generator stores data in XDG-compliant paths:
 *   ~/.local/share/report-gen/
 *     projects/{project}/
 *       manifests/{slug}.json
 *       research/{slug}-qa-transcript.md
 *       research/{slug}-qa-findings.md
 *       checkpoints/{slug}-qa-session.json
 */

import { readFileSync, existsSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { ReportManifest, ReportManifestResearchEntry } from "./types.ts";

const DEFAULT_DATA_DIR = join(homedir(), ".local", "share", "report-gen");

// ── Path Resolution ──────────────────────────────────────────────────────────

export function getDataDir(): string {
  return DEFAULT_DATA_DIR;
}

export function getProjectsDir(): string {
  return join(getDataDir(), "projects");
}

export function getProjectDir(project: string): string {
  return join(getProjectsDir(), project);
}

export function getManifestPath(project: string, slug: string): string {
  return join(getProjectDir(project), "manifests", `${slug}.json`);
}

export function getResearchDir(project: string): string {
  return join(getProjectDir(project), "research");
}

export function getTranscriptPath(project: string, slug: string): string {
  return join(getResearchDir(project), `${slug}-qa-transcript.md`);
}

export function getFindingsPath(project: string, slug: string): string {
  return join(getResearchDir(project), `${slug}-qa-findings.md`);
}

export function getCheckpointPath(project: string, slug: string): string {
  return join(getProjectDir(project), "checkpoints", `${slug}-qa-session.json`);
}

// ── Manifest Operations ──────────────────────────────────────────────────────

/**
 * Read a report manifest. Returns null if not found.
 */
export function readManifest(project: string, slug: string): ReportManifest | null {
  const path = getManifestPath(project, slug);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ReportManifest;
  } catch {
    return null;
  }
}

/**
 * Register QA transcript and findings in the manifest's research array.
 * Deduplicates — won't add if already present.
 */
export function registerResearchInManifest(
  project: string,
  slug: string,
  transcriptPath: string,
  findingsPath: string
): void {
  const manifestPath = getManifestPath(project, slug);
  if (!existsSync(manifestPath)) return;

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as ReportManifest;
    const existing = new Set(manifest.research.map((r) => r.file));

    const toAdd: ReportManifestResearchEntry[] = [];
    if (!existing.has(transcriptPath)) {
      toAdd.push({ file: transcriptPath, summary: "Q&A transcript (Telegram)" });
    }
    if (!existing.has(findingsPath)) {
      toAdd.push({ file: findingsPath, summary: "Q&A findings summary (Telegram)" });
    }

    if (toAdd.length > 0) {
      manifest.research.push(...toAdd);
      manifest.last_run = new Date().toISOString();
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    }
  } catch (err) {
    console.error("[report-qa] Failed to update manifest:", err);
  }
}

/**
 * Get the active project name from config.json.
 */
export function getActiveProject(): string | null {
  const configPath = join(getDataDir(), "config.json");
  if (!existsSync(configPath)) return null;
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    return config.activeProject ?? null;
  } catch {
    return null;
  }
}

/**
 * List all projects (non-deleted).
 */
export function listProjects(): string[] {
  const dir = getProjectsDir();
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * List all report slugs for a project (from manifests dir).
 */
export function listReports(project: string): string[] {
  const dir = join(getProjectDir(project), "manifests");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(".json", ""));
  } catch {
    return [];
  }
}

/**
 * Collect research content for context building.
 * Returns array of { file, content, summary } entries.
 * Budget: MAX_RESEARCH_CHARS total.
 */
export function collectResearchContext(
  manifest: ReportManifest,
  maxChars = 120_000
): Array<{ file: string; content: string; summary: string }> {
  const results: Array<{ file: string; content: string; summary: string }> = [];
  let budget = maxChars;

  for (const entry of manifest.research) {
    if (budget <= 0) break;
    // Skip QA transcript/findings — those are built separately
    if (entry.file.includes("-qa-transcript") || entry.file.includes("-qa-findings")) continue;
    if (!existsSync(entry.file)) continue;

    try {
      const content = readFileSync(entry.file, "utf-8");
      if (content.length <= budget) {
        results.push({ file: entry.file, content, summary: entry.summary ?? "" });
        budget -= content.length;
      } else if (entry.summary) {
        results.push({ file: entry.file, content: "", summary: entry.summary });
      }
    } catch {
      // Skip unreadable files
    }
  }

  return results;
}
