#!/usr/bin/env bun

/**
 * @routine tro-monthly-update
 * @description TRO Monthly Update automation: GitLab → Q&A → outline → PPTX draft
 * @schedule 0 8 8-14 * 5  (2nd Friday of month, 16:00 SGT = 08:00 UTC)
 * @target General AI Assistant group (personal chat for Q&A)
 *
 * Pipeline:
 *   Phase 1 — Collect GitLab activity (sub-group 96143, past 30 days)
 *           — Build continuity context from last 2-3 monthly PDF/PPTX files
 *   Phase 2 — Notify Furi: "data collected, starting analysis"
 *   Phase 3 — Generate context-aware questions via Claude (per-project + overall)
 *           — Send questions to Telegram; wait up to 15 min for answers
 *   Phase 4 — Generate outline.json via Claude
 *           — Run tro-pptx-generator.py to produce PPTX draft
 *   Phase 5 — Send completion notification with file path and key stats
 *
 * Run manually: bun run routines/tro-monthly-update.ts
 * Ad-hoc:       /monthly-update  (Telegram bot command)
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { sendAndRecord } from "../src/utils/routineMessage.ts";
import { sendToGroup } from "../src/utils/sendToGroup.ts";
import { GROUPS } from "../src/config/groups.ts";
import { claudeText } from "../src/claude-process.ts";
import { shouldSkipToday, markRanToday } from "../src/routines/runOnceGuard.ts";
import { setTROQAActive, clearTROQAActive } from "../src/tro/troQAState.ts";

// ── Constants ─────────────────────────────────────────────────────────────────

const PROJECT_ROOT = join(dirname(import.meta.dir));
const LAST_RUN_FILE = join(PROJECT_ROOT, "logs/tro-monthly-update.lastrun");

const GITLAB_BASE_URL = (process.env.GITLAB_BASE_URL ?? "https://gitlab.com").replace(/\/$/, "");
const GITLAB_API_URL = `${GITLAB_BASE_URL}/api/v4`;
const GITLAB_TOKEN = process.env.GITLAB_PERSONAL_ACCESS_TOKEN ?? "";
const GITLAB_GROUP_ID = "96143";

const TRO_BASE = join(
  homedir(),
  "Documents/WorkInGovTech/01_Projects/Agency_LTA/TRO"
);
const MONTHLY_UPDATES_DIR = join(TRO_BASE, "Monthly Updates");
const PPTX_GENERATOR = join(MONTHLY_UPDATES_DIR, "scripts/tro-pptx-generator.py");
const PDF_EXTRACTOR = join(MONTHLY_UPDATES_DIR, "scripts/tro-pdf-extract.py");
const LTA_TEMPLATE = join(
  homedir(),
  "Documents/WorkInGovTech/03_Resources/Templates/Presentation Templates/LTA_template_2025.pptx"
);

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

/** 15-minute Q&A wait window. */
const QA_TIMEOUT_MS = 15 * 60 * 1000;
/** How often to poll for context-qa.md (seconds). */
const QA_POLL_INTERVAL_MS = 20_000;

// ── Types ─────────────────────────────────────────────────────────────────────

interface GitLabProject {
  id: number;
  name: string;
  path_with_namespace: string;
}

interface GitLabIssue {
  id: number;
  title: string;
  state: string;
  project_id: number;
  created_at: string;
  closed_at?: string;
}

interface GitLabMR {
  id: number;
  title: string;
  state: string;
  project_id: number;
  created_at: string;
  merged_at?: string;
}

interface GitLabCommit {
  id: string;
  title: string;
  author_name: string;
  authored_date: string;
}

interface ProjectActivity {
  projectId: number;
  projectName: string;
  commits: GitLabCommit[];
  issues: GitLabIssue[];
  mrs: GitLabMR[];
}

interface GitLabActivity {
  period: { from: string; to: string };
  projects: ProjectActivity[];
  totalCommits: number;
  totalIssuesResolved: number;
  totalMRsMerged: number;
  contributors: string[];
  activeProjectCount: number;
}

// ── GitLab API helpers ────────────────────────────────────────────────────────

/** Single fetch with exponential backoff retry (learned from gitlab-repo-analyzer skill). */
async function gitlabFetch(url: string, attempt = 0): Promise<Response> {
  const MAX_RETRIES = 3;
  const res = await fetch(url, {
    headers: { "Authorization": `Bearer ${GITLAB_TOKEN}` },
  });

  // Fail fast — no retry on auth errors
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `GitLab auth error ${res.status}: verify GITLAB_PERSONAL_ACCESS_TOKEN has read_api scope.`
    );
  }
  if (res.status === 404) {
    throw new Error(`GitLab 404 — resource not found: ${url}`);
  }

  // Retry on rate-limit / transient server errors with exponential backoff + jitter
  if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
    const retryAfterHeader = res.headers.get("Retry-After");
    const baseMs = Math.min(60_000, 2 ** (attempt + 1) * 1000);
    const waitMs = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000
                                    : baseMs * (0.8 + Math.random() * 0.4);
    await new Promise((r) => setTimeout(r, waitMs));
    return gitlabFetch(url, attempt + 1);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitLab API ${res.status}: ${body.slice(0, 200)}`);
  }

  return res;
}

/** Paginated GitLab GET — uses Link header (rel="next") as per API v4. */
async function gitlabGet(path: string): Promise<unknown[]> {
  if (!GITLAB_TOKEN) {
    throw new Error("GITLAB_PERSONAL_ACCESS_TOKEN env var not set");
  }

  const results: unknown[] = [];
  const sep = path.includes("?") ? "&" : "?";
  let nextUrl: string | null = `${GITLAB_API_URL}${path}${sep}per_page=100`;

  while (nextUrl) {
    const res = await gitlabFetch(nextUrl);
    const data = await res.json() as unknown[];
    results.push(...data);

    // Link header: <https://gitlab.com/...?page=2>; rel="next", ...
    const link = res.headers.get("link") ?? "";
    const match = link.match(/<([^>]+)>;\s*rel="next"/);
    nextUrl = match ? match[1] : null;
  }

  return results;
}

/**
 * Pull 30-day activity for GitLab sub-group 96143.
 * Returns per-project breakdown plus aggregated stats.
 */
async function pullGitLabActivity(): Promise<GitLabActivity> {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const since = thirtyDaysAgo.toISOString();
  const until = now.toISOString();

  console.log(`Pulling GitLab activity since ${since}...`);

  // 1. List all projects in sub-group
  const allProjects = await gitlabGet(
    `/groups/${GITLAB_GROUP_ID}/projects?include_subgroups=true&order_by=last_activity_at`
  ) as GitLabProject[];

  console.log(`Found ${allProjects.length} projects`);

  // 2. Group-level issues (created or closed in period)
  const allIssues = await gitlabGet(
    `/groups/${GITLAB_GROUP_ID}/issues?scope=all&state=all&created_after=${since}`
  ) as GitLabIssue[];

  // 3. Group-level MRs
  const allMRs = await gitlabGet(
    `/groups/${GITLAB_GROUP_ID}/merge_requests?scope=all&state=all&created_after=${since}`
  ) as GitLabMR[];

  // 4. Per-project commits (parallel, limit to 20 most recently active projects)
  const recentProjects = allProjects.slice(0, 20);
  const commitsByProject = new Map<number, GitLabCommit[]>();

  await Promise.all(
    recentProjects.map(async (proj) => {
      try {
        const commits = await gitlabGet(
          `/projects/${proj.id}/repository/commits?since=${since}&until=${until}`
        ) as GitLabCommit[];
        if (commits.length > 0) {
          commitsByProject.set(proj.id, commits);
        }
      } catch {
        // Project may have no commits or restricted access — skip
      }
    })
  );

  // 5. Build per-project activity map
  const projectMap = new Map<number, GitLabProject>(allProjects.map((p) => [p.id, p]));
  const activityMap = new Map<number, ProjectActivity>();

  // Seed with projects that have commits
  for (const [projectId, commits] of commitsByProject) {
    const proj = projectMap.get(projectId);
    if (!proj) continue;
    activityMap.set(projectId, {
      projectId,
      projectName: proj.name,
      commits,
      issues: [],
      mrs: [],
    });
  }

  // Add issues to per-project buckets
  for (const issue of allIssues) {
    if (!activityMap.has(issue.project_id)) {
      const proj = projectMap.get(issue.project_id);
      if (proj) {
        activityMap.set(issue.project_id, {
          projectId: issue.project_id,
          projectName: proj.name,
          commits: [],
          issues: [],
          mrs: [],
        });
      }
    }
    activityMap.get(issue.project_id)?.issues.push(issue);
  }

  // Add MRs to per-project buckets
  for (const mr of allMRs) {
    if (!activityMap.has(mr.project_id)) {
      const proj = projectMap.get(mr.project_id);
      if (proj) {
        activityMap.set(mr.project_id, {
          projectId: mr.project_id,
          projectName: proj.name,
          commits: [],
          issues: [],
          mrs: [],
        });
      }
    }
    activityMap.get(mr.project_id)?.mrs.push(mr);
  }

  // Sort projects by total activity descending
  const projects = Array.from(activityMap.values()).sort(
    (a, b) =>
      (b.commits.length + b.issues.length + b.mrs.length) -
      (a.commits.length + a.issues.length + a.mrs.length)
  );

  // Extract unique contributors from commit author names
  const contributorSet = new Set<string>();
  for (const proj of projects) {
    for (const commit of proj.commits) {
      if (commit.author_name) contributorSet.add(commit.author_name);
    }
  }

  const totalCommits = projects.reduce((s, p) => s + p.commits.length, 0);
  const totalIssuesResolved = allIssues.filter((i) => i.state === "closed").length;
  const totalMRsMerged = allMRs.filter((m) => m.state === "merged").length;

  return {
    period: { from: since, to: until },
    projects,
    totalCommits,
    totalIssuesResolved,
    totalMRsMerged,
    contributors: Array.from(contributorSet),
    activeProjectCount: projects.length,
  };
}

/**
 * Convert GitLabActivity to a human-readable markdown summary.
 */
function buildActivityMarkdown(activity: GitLabActivity): string {
  const { period, projects, totalCommits, totalIssuesResolved, totalMRsMerged, contributors } = activity;
  const fromDate = new Date(period.from).toLocaleDateString("en-SG", { day: "numeric", month: "short", year: "numeric" });
  const toDate = new Date(period.to).toLocaleDateString("en-SG", { day: "numeric", month: "short", year: "numeric" });

  const lines: string[] = [
    `# TRO GitLab Activity Summary`,
    `**Period:** ${fromDate} – ${toDate}`,
    ``,
    `## Overview`,
    `- **Active projects:** ${projects.length}`,
    `- **Total commits:** ${totalCommits}`,
    `- **Issues resolved:** ${totalIssuesResolved}`,
    `- **MRs merged:** ${totalMRsMerged}`,
    `- **Contributors:** ${contributors.join(", ") || "none identified"}`,
    ``,
    `## Per-Project Activity`,
    ``,
  ];

  for (const proj of projects) {
    const resolvedIssues = proj.issues.filter((i) => i.state === "closed");
    lines.push(`### ${proj.projectName}`);
    lines.push(`- Commits: ${proj.commits.length}`);
    lines.push(`- Issues resolved: ${resolvedIssues.length}`);
    lines.push(`- MRs merged: ${proj.mrs.filter((m) => m.state === "merged").length}`);

    if (resolvedIssues.length > 0) {
      lines.push(`- Recent closed issues:`);
      for (const issue of resolvedIssues.slice(0, 5)) {
        lines.push(`  - ${issue.title}`);
      }
    }

    if (proj.commits.length > 0) {
      lines.push(`- Recent commits:`);
      for (const commit of proj.commits.slice(0, 3)) {
        lines.push(`  - ${commit.title}`);
      }
    }
    lines.push(``);
  }

  return lines.join("\n");
}

// ── Continuity context (past months PDFs/PPTX) ───────────────────────────────

/**
 * Run the PDF extractor Python script and return extracted text.
 */
async function extractPdfText(pdfPath: string): Promise<string> {
  const proc = Bun.spawn(["uv", "run", PDF_EXTRACTOR, pdfPath], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  if (exitCode !== 0) {
    throw new Error(`PDF extract failed (${exitCode}): ${stderr.slice(0, 200)}`);
  }

  return stdout.trim();
}

/**
 * Extract text from a PPTX file using python-pptx.
 */
async function extractPptxText(pptxPath: string): Promise<string> {
  const script = `
import sys
from pptx import Presentation
prs = Presentation(sys.argv[1])
texts = []
for slide in prs.slides:
    parts = []
    for shape in slide.shapes:
        if shape.has_text_frame:
            for para in shape.text_frame.paragraphs:
                t = para.text.strip()
                if t:
                    parts.append(t)
    if parts:
        texts.append('\\n'.join(parts))
print('\\n\\n---\\n\\n'.join(texts))
`.trim();

  const tmpScript = `/tmp/extract-pptx-${Date.now()}.py`;
  writeFileSync(tmpScript, script, "utf-8");

  const proc = Bun.spawn(["uv", "run", "--with", "python-pptx", tmpScript, pptxPath], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    proc.stderr && new Response(proc.stderr).text(),
  ]);

  try { Bun.spawnSync(["rm", tmpScript]); } catch { /* ignore */ }

  if (exitCode !== 0) return "";
  return stdout.trim();
}

/**
 * Find the PDF (ground truth) or fallback PPTX for a monthly folder.
 * Returns the absolute path and type, or null if nothing found.
 */
function findContextFile(folderPath: string): { path: string; type: "pdf" | "pptx" } | null {
  // 1. PDFs in folder root (ground truth)
  let entries: { path: string; mtime: number; type: "pdf" | "pptx" }[] = [];

  try {
    for (const name of readdirSync(folderPath)) {
      if (name.startsWith(".")) continue;
      const fullPath = join(folderPath, name);
      const lower = name.toLowerCase();

      if (lower.endsWith(".pdf")) {
        const mtime = statSync(fullPath).mtimeMs;
        entries.push({ path: fullPath, mtime, type: "pdf" });
      }
    }
  } catch { return null; }

  if (entries.length > 0) {
    // Return most recently modified PDF
    return entries.sort((a, b) => b.mtime - a.mtime)[0];
  }

  // 2. Fallback: PPTX in output/ subfolder
  const outputDir = join(folderPath, "output");
  if (existsSync(outputDir)) {
    try {
      for (const name of readdirSync(outputDir)) {
        if (name.toLowerCase().endsWith(".pptx")) {
          const fullPath = join(outputDir, name);
          const mtime = statSync(fullPath).mtimeMs;
          entries.push({ path: fullPath, mtime, type: "pptx" });
        }
      }
    } catch { /* ignore */ }

    if (entries.length > 0) {
      return entries.sort((a, b) => b.mtime - a.mtime)[0];
    }
  }

  return null;
}

/**
 * Build a continuity digest from the last 2-3 monthly update folders.
 * All subfolders in Monthly Updates/ are TRO-relevant (including ad-hoc updates).
 */
async function buildContinuityContext(currentFolderName: string): Promise<string> {
  if (!existsSync(MONTHLY_UPDATES_DIR)) {
    return "No past monthly updates found.";
  }

  // Get all subfolders sorted by modification time (newest first)
  let subfolders: { name: string; path: string; mtime: number }[] = [];
  try {
    for (const name of readdirSync(MONTHLY_UPDATES_DIR)) {
      const fullPath = join(MONTHLY_UPDATES_DIR, name);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory() && name !== currentFolderName && !name.startsWith(".")) {
          subfolders.push({ name, path: fullPath, mtime: stat.mtimeMs });
        }
      } catch { /* skip */ }
    }
  } catch {
    return "Could not read Monthly Updates directory.";
  }

  // Sort newest first, take last 3
  subfolders = subfolders
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 3);

  if (subfolders.length === 0) {
    return "No past monthly updates found.";
  }

  const contextParts: string[] = [];

  for (const folder of subfolders) {
    const contextFile = findContextFile(folder.path);
    if (!contextFile) {
      console.warn(`No PDF/PPTX found in ${folder.name} — skipping`);
      continue;
    }

    console.log(`Reading context from ${folder.name}: ${contextFile.path} (${contextFile.type})`);

    let rawText = "";
    try {
      if (contextFile.type === "pdf") {
        rawText = await extractPdfText(contextFile.path);
      } else {
        rawText = await extractPptxText(contextFile.path);
      }
    } catch (err) {
      console.warn(`Failed to extract text from ${contextFile.path}:`, err);
      continue;
    }

    if (!rawText.trim()) continue;

    // Truncate very long texts (keep first ~3000 chars per past document)
    const truncated = rawText.length > 3000 ? rawText.slice(0, 3000) + "\n...(truncated)" : rawText;
    contextParts.push(`## From: ${folder.name} (${contextFile.type.toUpperCase()})\n\n${truncated}`);
  }

  if (contextParts.length === 0) {
    return "No readable past monthly updates found.";
  }

  return `# Past Monthly Updates Context\n\n${contextParts.join("\n\n---\n\n")}`;
}

// ── LLM helpers ───────────────────────────────────────────────────────────────

/**
 * Generate context-aware questions for the Q&A phase.
 * Returns two sections: per-project questions + overall presentation questions.
 */
async function generateQuestions(
  activityMd: string,
  continuityContext: string
): Promise<{ perProject: string; overall: string; allQuestions: string[] }> {
  const prompt = `You are preparing a TRO (Technical & Research Operations) monthly update presentation for LTA (Land Transport Authority) leadership.

Here is the GitLab activity for the past 30 days:

${activityMd}

---

Here is context from past monthly updates:

${continuityContext.slice(0, 4000)}

---

Your job is to generate **context-aware questions** to ask the team lead (Furi) BEFORE generating the presentation. These questions will be answered via Telegram.

Generate exactly TWO sections:

**SECTION 1 — Per-Project Questions**
For EACH active project (one with commits, resolved issues, or MRs), generate 1-2 targeted questions based on:
- Anomalies (e.g. sudden drop in activity, spike in issues)
- Continuity gaps (e.g. something flagged as "coming next" in past reports that isn't showing in GitLab data)
- Missing context (e.g. unusual contributor count, MRs with no linked issues)
Keep each question specific and answerable in 1-2 sentences.

**SECTION 2 — Overall Presentation Questions**
Always include these 3 anchor questions (verbatim):
1. "Key win to highlight at the top of this presentation?"
2. "Any risks or blockers LTA leadership should know?"
3. "Audience composition same as last time, or different focus?"

Then add 1-2 context-derived questions based on the overall GitLab summary (e.g. trends, rate changes).

---

Format your response as a numbered flat list of ALL questions combined, prefixed with the project name (or "OVERALL" for section 2):

Example:
1. [DBC] AI drawing analysis had 0 commits this month after strong activity last month — is this intentional or blocked?
2. [Blueprint] The secure token generation system was mentioned as "in testing" last month — what's the current status?
3. [OVERALL] Key win to highlight at the top of this presentation?
4. [OVERALL] Any risks or blockers LTA leadership should know?
5. [OVERALL] Audience composition same as last time, or different focus?
6. [OVERALL] Active project rate appears to have changed from last month — should this be framed as focused delivery or flagged?

Return ONLY the numbered list. No preamble.`;

  const response = await claudeText(prompt, {
    model: "claude-sonnet-4-6",
    timeoutMs: 60_000,
    dangerouslySkipPermissions: true,
  });

  // Parse questions into per-project and overall sections
  const lines = response.split("\n").filter((l) => l.trim().match(/^\d+\./));
  const perProjectLines = lines.filter((l) => !l.includes("[OVERALL]"));
  const overallLines = lines.filter((l) => l.includes("[OVERALL]"));
  const allQuestions = lines.map((l) => l.replace(/^\d+\.\s*/, "").trim());

  return {
    perProject: perProjectLines.join("\n"),
    overall: overallLines.join("\n"),
    allQuestions,
  };
}

/**
 * Generate the slide outline.json from all available context.
 */
async function generateOutline(
  activityMd: string,
  continuityContext: string,
  qaAnswers: string,
  monthLabel: string,
  year: number,
  fromDate: string,
  toDate: string,
  contributors: string[]
): Promise<string> {
  const prompt = `Generate a JSON slide outline for the TRO Monthly Update presentation.

**Period:** ${fromDate} – ${toDate}
**Month/Year:** ${monthLabel} ${year}

**GitLab Activity:**
${activityMd.slice(0, 3000)}

**Past months context:**
${continuityContext.slice(0, 2000)}

**Furi's context answers (may be empty if unanswered):**
${qaAnswers || "No answers provided — use GitLab data only."}

**Team members (from GitLab contributors):**
${contributors.join(", ") || "Unknown — use last known team"}

---

Generate a valid JSON object with this structure:

{
  "period": "<N Month Year – N Month Year>",
  "generated_at": "<YYYY-MM-DD>",
  "slides": [
    {
      "type": "title",
      "title": "Monthly Update",
      "subtitle": "<Month Year>"
    },
    {
      "type": "three-columns",
      "title": "The Challenge",
      "left": ["<header>", "<point1>", "<point2>"],
      "center": ["<header>", "<point1>", "<point2>"],
      "right": ["<header>", "<point1>", "<point2>"]
    },
    ... one "bullets" slide per active project (sorted by activity) ...
    {
      "type": "bullets",
      "title": "<Project Name>",
      "bullets": ["<key achievement 1>", "<key achievement 2>", "<key achievement 3>", "<key achievement 4>"]
    },
    {
      "type": "bullets",
      "title": "By the Numbers",
      "bullets": ["<N> Code Commits — <insight>", "<N> Issues Resolved — <insight>", "<N>% Active Project Rate", "<N> Major Systems Enhanced"]
    },
    {
      "type": "bullets",
      "title": "Strategic Value for LTA",
      "bullets": ["<value 1>", "<value 2>", "<value 3>", "<value 4>", "<value 5>"]
    },
    {
      "type": "bullets",
      "title": "Looking Ahead — Next 30 Days",
      "bullets": ["<item 1>", "<item 2>", "<item 3>", "<item 4>"]
    },
    {
      "type": "closing",
      "team": ${JSON.stringify(contributors.length > 0 ? contributors.slice(0, 8) : ["GovTech Team"])}
    }
  ]
}

Rules:
- Include one "bullets" slide per active project (projects with commits OR resolved issues)
- Sort projects by total activity (commits + resolved issues) descending
- "By the Numbers" slide uses actual stats from GitLab data
- "The Challenge" should reflect real LTA transport technology challenges relevant to this period
- Bullet points should be concise (≤10 words each), focus on outcomes not tasks
- Return ONLY valid JSON, no markdown fences, no commentary`;

  const response = await claudeText(prompt, {
    model: "claude-sonnet-4-6",
    timeoutMs: 90_000,
    dangerouslySkipPermissions: true,
  });

  // Strip markdown code fences if Claude wrapped the JSON
  const cleaned = response
    .replace(/^```(?:json)?\n?/m, "")
    .replace(/\n?```$/m, "")
    .trim();

  // Validate it's parseable JSON
  JSON.parse(cleaned); // throws if invalid

  return cleaned;
}

// ── PPTX generation ───────────────────────────────────────────────────────────

async function runPptxGenerator(
  outlinePath: string,
  outputPath: string
): Promise<void> {
  const proc = Bun.spawn(
    ["uv", "run", PPTX_GENERATOR,
      "--outline", outlinePath,
      "--template", LTA_TEMPLATE,
      "--output", outputPath],
    { stdout: "pipe", stderr: "pipe" }
  );

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  if (exitCode !== 0) {
    throw new Error(`PPTX generator failed (${exitCode}): ${stderr.slice(0, 300)}`);
  }

  console.log(stdout.trim());
}

// ── Q&A wait loop ─────────────────────────────────────────────────────────────

/**
 * Wait for Q&A answers in context-qa.md (up to QA_TIMEOUT_MS).
 *
 * Closes early if no new content arrives for IDLE_CLOSE_MS after the
 * first answer — so a responsive Furi doesn't wait the full 15 minutes.
 * Falls back to full timeout if unanswered.
 *
 * Returns accumulated file content, or empty string if nothing was received.
 */
async function waitForQAAnswers(workspacePath: string): Promise<string> {
  const qaFile = join(workspacePath, "context-qa.md");
  const deadline = Date.now() + QA_TIMEOUT_MS;
  /** 90 s of silence after the last answer → close the window early. */
  const IDLE_CLOSE_MS = 90_000;

  let lastContentLen = 0;
  let idleDeadline = 0; // 0 = no answer received yet

  console.log(`Waiting for Q&A answers (timeout: ${QA_TIMEOUT_MS / 60000} min)...`);

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, QA_POLL_INTERVAL_MS));

    const currentLen = existsSync(qaFile)
      ? readFileSync(qaFile, "utf-8").length
      : 0;

    if (currentLen > lastContentLen) {
      lastContentLen = currentLen;
      idleDeadline = Date.now() + IDLE_CLOSE_MS;
    }

    if (idleDeadline > 0 && Date.now() >= idleDeadline) {
      console.log("Q&A idle close — 90 s since last answer, proceeding.");
      break;
    }
  }

  if (!existsSync(qaFile)) {
    console.log("Q&A timeout — no answers provided.");
    return "";
  }
  const content = readFileSync(qaFile, "utf-8").trim();
  if (!content) {
    console.log("Q&A timeout — no answers provided.");
  } else {
    console.log(`Q&A answers collected (${content.length} chars).`);
  }
  return content;
}

// ── Telegram helpers ──────────────────────────────────────────────────────────

function getNotifyChatId(): number {
  // Use the personal chat (TELEGRAM_USER_ID) for notifications
  const userId = parseInt(process.env.TELEGRAM_USER_ID ?? "0", 10);
  if (userId) return userId;

  // Fallback: GENERAL group
  return GROUPS.GENERAL?.chatId ?? 0;
}

async function sendMessage(chatId: number, text: string): Promise<void> {
  await sendAndRecord(chatId, text, {
    routineName: "tro-monthly-update",
    agentId: "general-assistant",
  });
}

// ── Folder helpers ────────────────────────────────────────────────────────────

function resolveMonthFolder(now: Date): {
  folderName: string;
  folderPath: string;
  monthLabel: string;
  year: number;
  outputFileName: string;
} {
  const monthLabel = MONTH_NAMES[now.getMonth()];
  const year = now.getFullYear();
  const folderName = `TRO_${monthLabel}${year}`;
  const folderPath = join(MONTHLY_UPDATES_DIR, folderName);
  const outputFileName = `TRO_${monthLabel}_${year}.pptx`;

  return { folderName, folderPath, monthLabel, year, outputFileName };
}

function ensureFolderStructure(folderPath: string): {
  analysisDir: string;
  workspaceDir: string;
  outputDir: string;
} {
  const analysisDir = join(folderPath, "analysis");
  const workspaceDir = join(folderPath, "workspace");
  const outputDir = join(folderPath, "output");

  mkdirSync(analysisDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });

  return { analysisDir, workspaceDir, outputDir };
}

// ── Main pipeline ─────────────────────────────────────────────────────────────

async function run(forceRun = false): Promise<void> {
  const now = new Date();

  // Run-once guard (skip if already ran today unless forced)
  if (!forceRun && shouldSkipToday(LAST_RUN_FILE)) {
    console.log("TRO monthly update already ran today — skipping.");
    return;
  }

  const { folderName, folderPath, monthLabel, year, outputFileName } = resolveMonthFolder(now);
  const { analysisDir, workspaceDir, outputDir } = ensureFolderStructure(folderPath);

  const yyyymm = `${year}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const activityJsonPath = join(analysisDir, `gitlab-activity-${yyyymm}.json`);
  const activityMdPath = join(analysisDir, `gitlab-activity-${yyyymm}.md`);
  const continuityMdPath = join(analysisDir, "past-months-context.md");
  const outlineJsonPath = join(workspaceDir, "outline.json");
  const outputPptxPath = join(outputDir, outputFileName);

  const chatId = getNotifyChatId();

  console.log(`\n=== TRO Monthly Update — ${monthLabel} ${year} ===`);
  console.log(`Folder: ${folderPath}`);

  // ── Phase 1: Data collection ────────────────────────────────────────────────
  console.log("\n[Phase 1] Collecting GitLab activity...");

  let activity: GitLabActivity;
  let activityMd: string;
  let continuityContext: string;

  try {
    activity = await pullGitLabActivity();
    activityMd = buildActivityMarkdown(activity);

    writeFileSync(activityJsonPath, JSON.stringify(activity, null, 2), "utf-8");
    writeFileSync(activityMdPath, activityMd, "utf-8");

    console.log(
      `GitLab: ${activity.activeProjectCount} active projects, ` +
      `${activity.totalCommits} commits, ${activity.totalIssuesResolved} issues resolved`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("GitLab pull failed:", msg);
    await sendMessage(chatId,
      `TRO Monthly Update — GitLab data collection failed.\n\nError: ${msg}\n\nPlease check GITLAB_BASE_URL and GITLAB_PERSONAL_ACCESS_TOKEN, then retry with /monthly-update.`
    );
    return;
  }

  try {
    continuityContext = await buildContinuityContext(folderName);
    writeFileSync(continuityMdPath, continuityContext, "utf-8");
    console.log("Continuity context built.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("Continuity context failed (non-fatal):", msg);
    continuityContext = "No past context available.";
  }

  // ── Phase 2: Notify ─────────────────────────────────────────────────────────
  console.log("\n[Phase 2] Sending 'analysis starting' notification...");
  await sendMessage(chatId,
    `TRO Monthly Update — data collected for ${monthLabel} ${year}.\n\n` +
    `Projects analysed: ${activity.activeProjectCount} | ` +
    `Commits: ${activity.totalCommits} | ` +
    `Issues resolved: ${activity.totalIssuesResolved}\n\n` +
    `Starting analysis and context questions now...`
  );

  // Mark as ran now — Phase 1 & 2 are done, Telegram notified.
  // This prevents a re-run if Phase 3/4 crashes and PM2 restarts on the same day
  // (which would cause duplicate GitLab pulls and duplicate Telegram messages).
  // Use /monthly_update to force a re-run manually.
  if (!forceRun) {
    markRanToday(LAST_RUN_FILE);
  }

  // ── Phase 3a: Generate questions ────────────────────────────────────────────
  console.log("\n[Phase 3a] Generating context-aware questions...");

  let questions: { perProject: string; overall: string; allQuestions: string[] };
  try {
    questions = await generateQuestions(activityMd, continuityContext);
    console.log(`Generated ${questions.allQuestions.length} questions.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Question generation failed:", msg);
    questions = {
      perProject: "",
      overall: "1. [OVERALL] Key win to highlight at the top of this presentation?\n2. [OVERALL] Any risks or blockers LTA leadership should know?\n3. [OVERALL] Audience composition same as last time, or different focus?",
      allQuestions: [
        "Key win to highlight at the top of this presentation?",
        "Any risks or blockers LTA leadership should know?",
        "Audience composition same as last time, or different focus?",
      ],
    };
  }

  // ── Phase 3a: Send questions to Telegram ───────────────────────────────────
  const questionMessage =
    `TRO Monthly Update — Context Q&A\n\n` +
    `Please answer the following questions to help shape the presentation. ` +
    `Reply in plain text — each reply will be recorded. ` +
    `You have **15 minutes**. If you don't reply, I'll proceed with GitLab data only.\n\n` +
    (questions.perProject ? `**Per-project questions:**\n${questions.perProject}\n\n` : "") +
    `**Overall presentation questions:**\n${questions.overall}`;

  await sendMessage(chatId, questionMessage);

  // Register Q&A flag so relay can route replies
  setTROQAActive({
    workspacePath: workspaceDir,
    chatId,
    questions: questions.allQuestions,
    startedAt: new Date().toISOString(),
  });

  // ── Phase 3a: Wait for answers ──────────────────────────────────────────────
  const qaAnswers = await waitForQAAnswers(workspaceDir);
  clearTROQAActive();

  if (!qaAnswers) {
    await sendMessage(chatId,
      `TRO Monthly Update — Q&A timeout. Proceeding with GitLab data only.`
    );
  }

  // ── Phase 3b: Generate outline ──────────────────────────────────────────────
  console.log("\n[Phase 3b] Generating slide outline...");

  const fromDate = new Date(activity.period.from).toLocaleDateString("en-SG", {
    day: "numeric", month: "long", year: "numeric"
  });
  const toDate = new Date(activity.period.to).toLocaleDateString("en-SG", {
    day: "numeric", month: "long", year: "numeric"
  });

  let outlineJson: string;
  try {
    outlineJson = await generateOutline(
      activityMd,
      continuityContext,
      qaAnswers,
      monthLabel,
      year,
      fromDate,
      toDate,
      activity.contributors
    );
    writeFileSync(outlineJsonPath, outlineJson, "utf-8");
    console.log("outline.json written.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Outline generation failed:", msg);
    await sendMessage(chatId,
      `TRO Monthly Update — outline generation failed.\n\nError: ${msg}\n\nPlease check Claude CLI access and retry with /monthly-update.`
    );
    return;
  }

  // ── Phase 4: Generate PPTX ─────────────────────────────────────────────────
  console.log("\n[Phase 4] Generating PPTX...");

  try {
    await runPptxGenerator(outlineJsonPath, outputPptxPath);
    console.log(`PPTX written: ${outputPptxPath}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("PPTX generation failed:", msg);
    await sendMessage(chatId,
      `TRO Monthly Update — PPTX generation failed.\n\nError: ${msg}\n\nThe outline.json is ready at:\n${outlineJsonPath}\n\nYou can retry the PPTX step manually.`
    );
    return;
  }

  // ── Phase 5: Completion notification ───────────────────────────────────────
  const outlineData = JSON.parse(outlineJson) as { slides?: unknown[] };
  const slideCount = outlineData.slides?.length ?? 0;

  const completionMsg =
    `TRO Monthly Update draft ready\n\n` +
    `Period: ${fromDate} – ${toDate}\n` +
    `File: ${outputPptxPath}\n\n` +
    `Active projects: ${activity.activeProjectCount}\n` +
    `Commits: ${activity.totalCommits}\n` +
    `Issues resolved: ${activity.totalIssuesResolved}\n` +
    `MRs merged: ${activity.totalMRsMerged}\n` +
    `Slides: ${slideCount}\n\n` +
    `Ready for your review.`;

  await sendMessage(chatId, completionMsg);
  console.log("\n=== TRO Monthly Update complete ===");
}

// ── Entry point ───────────────────────────────────────────────────────────────

const isAdHoc = process.argv.includes("--force") || process.argv.includes("--ad-hoc");

run(isAdHoc).catch(async (err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("TRO monthly update fatal error:", msg);

  clearTROQAActive();

  const chatId = getNotifyChatId();
  if (chatId) {
    try {
      await sendToGroup(chatId, `TRO Monthly Update — fatal error:\n\n${msg}`);
    } catch { /* ignore secondary failure */ }
  }

  process.exit(1);
});
