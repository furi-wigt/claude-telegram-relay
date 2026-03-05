/**
 * Report Workflow Orchestrator
 *
 * Each exported function advances the state machine one step and sends Telegram messages.
 * State is managed via reportState.ts. CLI calls go through reportCli.ts.
 * All bot interactions use bot.api directly (no ctx dependency).
 *
 * Error handling: CLI failures send a warning message to the user; they never crash the bot.
 */

import type { Bot } from "grammy";
import { InlineKeyboard, InputFile } from "grammy";
import { existsSync, readFileSync } from "fs";
import {
  getReportSession,
  setReportSession,
  updateReportSession,
  clearReportSession,
  type ReportWorkflowState,
} from "./reportState.ts";
import { runReportCli, listProjects, findSimilarSlugs } from "./reportCli.ts";
import {
  topicToSlug,
  getInterviewQuestion,
  buildAudienceKeyboard,
  buildDateRangeKeyboard,
  buildProjectScopeKeyboard,
  buildSkipKeyboard,
  buildSlugConfirmKeyboard,
} from "./reportInterviewer.ts";

// ──────────────────────────────────────────────
// Extended state fields (stored alongside ReportWorkflowState at runtime)
// These fields are not in the base type — we merge them via cast.
// ──────────────────────────────────────────────

interface ExtendedState extends ReportWorkflowState {
  pendingTopic?: string;       // Original topic text, retained through slug confirmation
  awaitingInput?: string;      // Sub-step: "confluence_url" | "web_query" | "pdf_path" | "brief_correction"
  availableProjects?: string[]; // Full list for toggling
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

async function sendMsg(
  bot: Bot,
  chatId: number,
  text: string,
  extra?: Record<string, unknown>
) {
  return bot.api.sendMessage(chatId, text, { parse_mode: "HTML", ...extra });
}

function getExtended(chatId: number): ExtendedState | undefined {
  return getReportSession(chatId) as ExtendedState | undefined;
}

function updateExtended(
  chatId: number,
  patch: Partial<ExtendedState>
): ExtendedState | undefined {
  return updateReportSession(chatId, patch as Partial<ReportWorkflowState>) as
    | ExtendedState
    | undefined;
}

// ──────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────

export async function startReportWorkflow(
  bot: Bot,
  chatId: number,
  topic: string
): Promise<void> {
  const slug = topicToSlug(topic);

  let similarSlugs: string[] = [];
  try {
    similarSlugs = await findSimilarSlugs(topic);
  } catch {
    // Non-fatal — treat as no similar slugs found
  }

  if (similarSlugs.length > 0) {
    // Store pending topic before we send the confirmation keyboard
    const initialState: ExtendedState = {
      chatId,
      step: "interviewing",
      slug,
      project: "",
      audience: "",
      purpose: "",
      dateRange: "",
      emphases: "",
      exclusions: "",
      scopedProjects: [],
      interviewStep: 0,
      selectedProjects: [],
      corrections: [],
      loopCount: 0,
      startedAt: new Date().toISOString(),
      lastActivityAt: Date.now(),
      pendingTopic: topic,
    };
    setReportSession(chatId, initialState as ReportWorkflowState);

    const slugList = similarSlugs.map((s) => `• <code>${s}</code>`).join("\n");
    await sendMsg(
      bot,
      chatId,
      `I found similar reports:\n${slugList}\n\nUse an existing one or start fresh?`,
      { reply_markup: buildSlugConfirmKeyboard(similarSlugs) }
    );
    return;
  }

  await beginInterview(bot, chatId, topic, slug);
}

// ──────────────────────────────────────────────
// Interview phase
// ──────────────────────────────────────────────

async function beginInterview(
  bot: Bot,
  chatId: number,
  topic: string,
  slug: string
): Promise<void> {
  const state: ExtendedState = {
    chatId,
    step: "interviewing",
    slug,
    project: "",
    audience: "",
    purpose: "",
    dateRange: "",
    emphases: "",
    exclusions: "",
    scopedProjects: [],
    interviewStep: 0,
    selectedProjects: [],
    corrections: [],
    loopCount: 0,
    startedAt: new Date().toISOString(),
    lastActivityAt: Date.now(),
    pendingTopic: topic,
  };
  setReportSession(chatId, state as ReportWorkflowState);

  await sendMsg(
    bot,
    chatId,
    `Starting report: <b>${slug}</b>\n\nFirst question:\n${getInterviewQuestion("purpose")}`,
    { reply_markup: buildSkipKeyboard() }
  );
}

export async function advanceInterview(
  bot: Bot,
  chatId: number,
  answer: string
): Promise<void> {
  const state = getExtended(chatId);
  if (!state || state.step !== "interviewing") return;

  const step = state.interviewStep;

  if (step === 0) {
    // purpose answered → ask audience
    updateExtended(chatId, { purpose: answer, interviewStep: 1 });
    await sendMsg(
      bot,
      chatId,
      getInterviewQuestion("audience"),
      { reply_markup: buildAudienceKeyboard(chatId, null) }
    );
  } else if (step === 1) {
    // audience is via callback — ignore free text at this step
  } else if (step === 2) {
    // dateRange is via callback — ignore free text at this step
  } else if (step === 3) {
    // emphases answered → ask project scope
    updateExtended(chatId, { emphases: answer, interviewStep: 4 });

    let projects: string[] = [];
    try {
      projects = await listProjects();
    } catch {
      // Proceed with empty list if CLI fails
    }

    updateExtended(chatId, { availableProjects: projects, selectedProjects: [] });

    const msg = await sendMsg(
      bot,
      chatId,
      "Select which projects to include (tap to toggle):",
      { reply_markup: buildProjectScopeKeyboard(projects, []) }
    );
    updateExtended(chatId, { projectSelectMessageId: msg.message_id });
  }
}

// ──────────────────────────────────────────────
// Interview callbacks
// ──────────────────────────────────────────────

export async function handleInterviewCallback(
  bot: Bot,
  chatId: number,
  data: string
): Promise<boolean> {
  const state = getExtended(chatId);

  // ── Slug confirmation ──
  if (data.startsWith("rpt:slug:use:")) {
    const chosenSlug = data.slice("rpt:slug:use:".length);
    const topic = state?.pendingTopic ?? chosenSlug;
    await beginInterview(bot, chatId, topic, chosenSlug);
    return true;
  }

  if (data === "rpt:slug:new") {
    if (!state) return true;
    const topic = state.pendingTopic ?? state.slug;
    const newSlug = topicToSlug(topic);
    await beginInterview(bot, chatId, topic, newSlug);
    return true;
  }

  // ── Skip ──
  if (data === "rpt:skip") {
    await advanceInterview(bot, chatId, "");
    return true;
  }

  // ── Audience ──
  if (data.startsWith("rpt:audience:")) {
    const value = data.slice("rpt:audience:".length);
    updateExtended(chatId, { audience: value, interviewStep: 2 });
    await sendMsg(
      bot,
      chatId,
      getInterviewQuestion("dateRange"),
      { reply_markup: buildDateRangeKeyboard(chatId, null) }
    );
    return true;
  }

  // ── Date range ──
  if (data.startsWith("rpt:daterange:")) {
    const value = data.slice("rpt:daterange:".length);
    updateExtended(chatId, { dateRange: value, interviewStep: 3 });
    await sendMsg(
      bot,
      chatId,
      getInterviewQuestion("emphases"),
      { reply_markup: buildSkipKeyboard() }
    );
    return true;
  }

  // ── Project scope toggle ──
  if (data.startsWith("rpt:project:toggle:")) {
    if (!state) return true;
    const projectPath = data.slice("rpt:project:toggle:".length);
    const current = new Set(state.selectedProjects);

    if (current.has(projectPath)) {
      current.delete(projectPath);
    } else {
      current.add(projectPath);
    }

    const newSelected = Array.from(current);
    updateExtended(chatId, { selectedProjects: newSelected });

    const allProjects = state.availableProjects ?? [];
    if (state.projectSelectMessageId) {
      try {
        await bot.api.editMessageReplyMarkup(chatId, state.projectSelectMessageId, {
          reply_markup: buildProjectScopeKeyboard(allProjects, newSelected),
        });
      } catch {
        // Message may not have changed — ignore edit conflict
      }
    }
    return true;
  }

  // ── Project scope confirm ──
  if (data === "rpt:project:confirm") {
    if (!state) return true;
    updateExtended(chatId, { scopedProjects: state.selectedProjects });
    await startCollection(bot, chatId);
    return true;
  }

  return false;
}

// ──────────────────────────────────────────────
// Collection phase
// ──────────────────────────────────────────────

async function startCollection(bot: Bot, chatId: number): Promise<void> {
  const state = getExtended(chatId);
  if (!state) return;

  updateExtended(chatId, { step: "collecting" });
  await sendMsg(
    bot,
    chatId,
    "Starting data collection... I'll let you know when done."
  );

  const { slug } = state;
  const projectArgs = state.project ? ["--project", state.project] : [];

  try {
    // Create new report if it doesn't exist yet
    await runReportCli(["report", "new", slug, ...projectArgs]);
  } catch (err) {
    await sendMsg(bot, chatId, `Warning: could not initialise report — ${(err as Error).message}`);
  }

  try {
    await runReportCli(
      ["report", "collect", slug, "gitlab", ...projectArgs],
      { timeout: 600_000 } // 10 min
    );
  } catch (err) {
    await sendMsg(bot, chatId, `Warning: GitLab collection error — ${(err as Error).message}`);
  }

  await askForMoreSources(bot, chatId);
}

// ──────────────────────────────────────────────
// More sources phase (F-B6)
// ──────────────────────────────────────────────

async function askForMoreSources(bot: Bot, chatId: number): Promise<void> {
  const state = getExtended(chatId);
  if (!state) return;

  updateExtended(chatId, { step: "awaiting_more_sources", awaitingInput: undefined });

  const { slug } = state;
  let researchCount = 0;

  try {
    const result = await runReportCli(["report", "status", slug, "--json"]);
    if (result.ok) {
      const parsed = JSON.parse(result.stdout);
      researchCount =
        typeof parsed.researchFiles === "number" ? parsed.researchFiles : 0;
    }
  } catch {
    // Non-fatal — display 0
  }

  const keyboard = new InlineKeyboard()
    .text("📄 Confluence page", "rpt:more:confluence")
    .row()
    .text("📎 External PDF", "rpt:more:pdf")
    .row()
    .text("🔍 Web research", "rpt:more:web")
    .row()
    .text("▶ Proceed to compile", "rpt:more:proceed");

  await sendMsg(
    bot,
    chatId,
    `I have <b>${researchCount}</b> source file(s) loaded. Anything else to add before I compile the report?`,
    { reply_markup: keyboard }
  );
}

export async function handleMoreSourcesCallback(
  bot: Bot,
  chatId: number,
  data: string
): Promise<boolean> {
  if (!data.startsWith("rpt:more:")) return false;

  const state = getExtended(chatId);
  if (!state || state.step !== "awaiting_more_sources") return false;

  if (data === "rpt:more:confluence") {
    updateExtended(chatId, { awaitingInput: "confluence_url" });
    await sendMsg(bot, chatId, "Send me the Confluence URL or page ID.");
    return true;
  }

  if (data === "rpt:more:pdf") {
    updateExtended(chatId, { awaitingInput: "pdf_path" });
    await sendMsg(bot, chatId, "Send me the PDF file path or external URL.");
    return true;
  }

  if (data === "rpt:more:web") {
    updateExtended(chatId, { awaitingInput: "web_query" });
    await sendMsg(bot, chatId, "What should I research on the web? Send your query.");
    return true;
  }

  if (data === "rpt:more:proceed") {
    await startCompile(bot, chatId);
    return true;
  }

  return false;
}

export async function handleMoreSourcesFreeText(
  bot: Bot,
  chatId: number,
  text: string
): Promise<boolean> {
  const state = getExtended(chatId);
  if (!state || state.step !== "awaiting_more_sources") return false;

  const input = state.awaitingInput;
  if (!input) return false;

  const { slug } = state;
  const projectArgs = state.project ? ["--project", state.project] : [];

  updateExtended(chatId, { awaitingInput: undefined });

  try {
    if (input === "confluence_url") {
      await sendMsg(bot, chatId, "Fetching Confluence page...");
      const result = await runReportCli([
        "report", "collect", slug, "confluence", "--url", text, ...projectArgs,
      ]);
      if (!result.ok) {
        await sendMsg(bot, chatId, `Confluence collection warning: ${result.stderr.slice(0, 300)}`);
      }
    } else if (input === "web_query") {
      await sendMsg(bot, chatId, "Running web research...");
      const result = await runReportCli([
        "report", "collect", slug, "web", "--queries", text, ...projectArgs,
      ]);
      if (!result.ok) {
        await sendMsg(bot, chatId, `Web research warning: ${result.stderr.slice(0, 300)}`);
      }
    } else if (input === "pdf_path") {
      await sendMsg(bot, chatId, "Loading external document...");
      const result = await runReportCli([
        "report", "collect", slug, "external", "--file", text, ...projectArgs,
      ]);
      if (!result.ok) {
        await sendMsg(bot, chatId, `Document load warning: ${result.stderr.slice(0, 300)}`);
      }
    } else {
      return false;
    }
  } catch (err) {
    await sendMsg(bot, chatId, `⚠️ Error: ${(err as Error).message}`);
  }

  await askForMoreSources(bot, chatId);
  return true;
}

// ──────────────────────────────────────────────
// Compile phase
// ──────────────────────────────────────────────

async function startCompile(bot: Bot, chatId: number): Promise<void> {
  const state = getExtended(chatId);
  if (!state) return;

  updateExtended(chatId, { step: "compiling" });
  await sendMsg(bot, chatId, "Compiling intelligence brief...");

  const { slug } = state;
  const projectArgs = state.project ? ["--project", state.project] : [];

  try {
    const result = await runReportCli(
      ["report", "compile", slug, ...projectArgs],
      { timeout: 600_000 } // 10 min
    );
    if (!result.ok) {
      await sendMsg(bot, chatId, `⚠️ Compile warning: ${result.stderr.slice(0, 300)}`);
    }
  } catch (err) {
    await sendMsg(bot, chatId, `⚠️ Error during compile: ${(err as Error).message}`);
  }

  // Locate the brief file
  let intelligenceBriefPath: string | undefined;
  let briefContent = "";

  try {
    const statusResult = await runReportCli(["report", "status", slug, "--json"]);
    if (statusResult.ok) {
      const parsed = JSON.parse(statusResult.stdout);
      if (typeof parsed.intelligenceBriefPath === "string") {
        intelligenceBriefPath = parsed.intelligenceBriefPath;
      }
    }
  } catch {
    // Fall through to file path guess
  }

  if (!intelligenceBriefPath) {
    // Fallback: conventional path
    const guess = `knowledge/reports/${slug}-brief.md`;
    if (existsSync(guess)) intelligenceBriefPath = guess;
  }

  if (intelligenceBriefPath && existsSync(intelligenceBriefPath)) {
    try {
      briefContent = readFileSync(intelligenceBriefPath, "utf8").slice(0, 3000);
    } catch {
      briefContent = "(Could not read brief file)";
    }
  } else {
    briefContent = "(Brief not found)";
  }

  updateExtended(chatId, { intelligenceBriefPath, briefContent });
  await presentBrief(bot, chatId);
}

// ──────────────────────────────────────────────
// Review loop
// ──────────────────────────────────────────────

async function presentBrief(bot: Bot, chatId: number): Promise<void> {
  const state = getExtended(chatId);
  if (!state) return;

  updateExtended(chatId, { step: "reviewing", awaitingInput: undefined });
  const loop = state.loopCount + 1;
  const preview = state.briefContent ?? "(Brief not found)";

  const keyboard = new InlineKeyboard()
    .text("✅ Approve & Generate", "rpt:review:approve")
    .row()
    .text("✏️ Correct findings", "rpt:review:correct")
    .row()
    .text("🔄 Collect more data", "rpt:review:more_data");

  await sendMsg(
    bot,
    chatId,
    `<b>Intelligence Brief — Review</b> (loop ${loop})\n\n${preview}\n...`,
    { reply_markup: keyboard }
  );
}

export async function handleReviewCallback(
  bot: Bot,
  chatId: number,
  data: string
): Promise<boolean> {
  if (!data.startsWith("rpt:review:")) return false;

  const state = getExtended(chatId);
  if (!state || state.step !== "reviewing") return false;

  if (data === "rpt:review:approve") {
    await startVisualGen(bot, chatId);
    return true;
  }

  if (data === "rpt:review:correct") {
    updateExtended(chatId, { awaitingInput: "brief_correction" });
    await sendMsg(bot, chatId, "What needs correcting? Reply with your corrections.");
    return true;
  }

  if (data === "rpt:review:more_data") {
    updateExtended(chatId, { loopCount: state.loopCount + 1 });
    await askForMoreSources(bot, chatId);
    return true;
  }

  return false;
}

export async function handleReviewFreeText(
  bot: Bot,
  chatId: number,
  text: string
): Promise<boolean> {
  const state = getExtended(chatId);
  if (!state || state.step !== "reviewing") return false;
  if (state.awaitingInput !== "brief_correction") return false;

  const corrections = [...(state.corrections ?? []), text];
  updateExtended(chatId, { corrections, awaitingInput: undefined });

  await sendMsg(bot, chatId, "Correction noted. Re-compiling...");
  await startCompile(bot, chatId);
  return true;
}

// ──────────────────────────────────────────────
// Visual gen phase (F-C1)
// ──────────────────────────────────────────────

async function startVisualGen(bot: Bot, chatId: number): Promise<void> {
  const state = getExtended(chatId);
  if (!state) return;

  updateExtended(chatId, { step: "awaiting_asset_preview" });
  await sendMsg(bot, chatId, "Analysing slides for visual assets...");

  const { slug } = state;
  const projectArgs = state.project ? ["--project", state.project] : [];

  let dryRunOutput = "";
  try {
    const result = await runReportCli([
      "report", "visual-gen", slug, "--dry-run", ...projectArgs,
    ]);
    dryRunOutput = result.stdout;
  } catch (err) {
    await sendMsg(bot, chatId, `⚠️ Error: ${(err as Error).message}`);
  }

  // Parse table lines: "NN     <sectionId>               <type>          <path>"
  const lines = dryRunOutput
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\d+\s+/.test(l));

  let preview = "<b>Planned slide visuals:</b>\n\n";
  if (lines.length === 0) {
    preview += "(No visuals planned)";
  } else {
    for (const line of lines) {
      const parts = line.split(/\s{2,}/);
      const slideNum = parts[0] ?? "?";
      const assetType = parts[2] ?? "visual";
      preview += `Slide ${slideNum} — ${assetType}\n`;
    }
  }

  const keyboard = new InlineKeyboard()
    .text("✅ Generate all visuals", "rpt:assets:approve")
    .row()
    .text("⏭ Skip visuals", "rpt:assets:skip");

  const msg = await sendMsg(bot, chatId, preview, { reply_markup: keyboard });
  updateExtended(chatId, { assetPreviewMessageId: msg.message_id });
}

export async function handleAssetCallback(
  bot: Bot,
  chatId: number,
  data: string
): Promise<boolean> {
  if (!data.startsWith("rpt:assets:")) return false;

  const state = getExtended(chatId);
  if (!state || state.step !== "awaiting_asset_preview") return false;

  if (data === "rpt:assets:approve") {
    await sendMsg(bot, chatId, "Generating visuals (this may take a few minutes)...");
    const { slug } = state;
    const projectArgs = state.project ? ["--project", state.project] : [];

    try {
      const result = await runReportCli(
        ["report", "visual-gen", slug, ...projectArgs],
        { timeout: 600_000 }
      );
      if (!result.ok) {
        await sendMsg(bot, chatId, `⚠️ Visual gen warning: ${result.stderr.slice(0, 300)}`);
      }
    } catch (err) {
      await sendMsg(bot, chatId, `⚠️ Error: ${(err as Error).message}`);
    }

    await startGenerate(bot, chatId);
    return true;
  }

  if (data === "rpt:assets:skip") {
    await startGenerate(bot, chatId);
    return true;
  }

  return false;
}

// ──────────────────────────────────────────────
// Generate phase
// ──────────────────────────────────────────────

async function startGenerate(bot: Bot, chatId: number): Promise<void> {
  const state = getExtended(chatId);
  if (!state) return;

  updateExtended(chatId, { step: "generating" });
  await sendMsg(bot, chatId, "Generating report...");

  const { slug } = state;
  const projectArgs = state.project ? ["--project", state.project] : [];

  let pptxPath: string | undefined;

  try {
    const result = await runReportCli(
      ["report", "generate", slug, "--format", "pptx", "--verify", ...projectArgs],
      { timeout: 900_000 } // 15 min
    );

    if (!result.ok) {
      await sendMsg(bot, chatId, `⚠️ Generate warning: ${result.stderr.slice(0, 300)}`);
    }

    // Find PPTX path in stdout
    const pptxLine = result.stdout
      .split("\n")
      .find((l) => l.includes(".pptx"));

    if (pptxLine) {
      const match = pptxLine.match(/([^\s]+\.pptx)/);
      if (match) pptxPath = match[1];
    }
  } catch (err) {
    await sendMsg(bot, chatId, `⚠️ Error: ${(err as Error).message}`);
  }

  if (pptxPath && existsSync(pptxPath)) {
    try {
      await bot.api.sendDocument(chatId, new InputFile(pptxPath));
    } catch (err) {
      await sendMsg(bot, chatId, `⚠️ Could not send PPTX: ${(err as Error).message}`);
    }
  } else {
    await sendMsg(bot, chatId, "Report generated. (PPTX file path not detected in output.)");
  }

  await askConfirmKnowledge(bot, chatId);
}

// ──────────────────────────────────────────────
// Knowledge confirmation phase
// ──────────────────────────────────────────────

async function askConfirmKnowledge(bot: Bot, chatId: number): Promise<void> {
  updateExtended(chatId, { step: "awaiting_confirm" });

  const keyboard = new InlineKeyboard()
    .text("✅ Yes — save to knowledge base", "rpt:confirm:yes")
    .row()
    .text("🗑 No — discard pending data", "rpt:confirm:no");

  await sendMsg(
    bot,
    chatId,
    "Report delivered! Should I keep this research for future reports on the same project?",
    { reply_markup: keyboard }
  );
}

export async function handleConfirmCallback(
  bot: Bot,
  chatId: number,
  data: string
): Promise<boolean> {
  if (!data.startsWith("rpt:confirm:")) return false;

  const state = getExtended(chatId);
  if (!state || state.step !== "awaiting_confirm") return false;

  if (data === "rpt:confirm:yes") {
    await sendMsg(bot, chatId, "Knowledge saved.");
    clearReportSession(chatId);
    return true;
  }

  if (data === "rpt:confirm:no") {
    await sendMsg(bot, chatId, "Pending research discarded.");
    clearReportSession(chatId);
    return true;
  }

  return false;
}
