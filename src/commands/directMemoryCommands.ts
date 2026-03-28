/**
 * Direct Memory Mutation Commands
 *
 * Adds four commands for explicit memory management with +/- syntax:
 *   /goals  +goal1 | +goal2 | -old goal text
 *   /goals  *goal1 | *2  — mark goal as done (index or fuzzy match)
 *   /goals  *           — list completed/archived goals
 *   /facts  +fact1 | -old fact
 *   /prefs  +prefer X | -old preference
 *   /reminders +Meeting Friday 3pm | -old reminder
 *
 * - `+item` adds a new entry
 * - `-item` removes matching entry using Ollama fuzzy match (fallback: ilike)
 * - `*item` or `*N` marks matching goal as done/undone (toggle)
 * - Question UI (InlineKeyboard) is shown when multiple candidates match
 */

import type { Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { claudeText } from "../claude-process.ts";
import { saveCommandInteraction } from "../utils/saveMessage.ts";
import { findPotentialDuplicates, parseModelIndices } from "../utils/duplicateDetector.ts";
import { chunkMessage } from "../utils/sendToGroup.ts";
import { resolveSourceLabel } from "../utils/chatNames.ts";
import { insertMemoryRecord, deleteMemoryRecord, updateMemoryRecord } from "../local/storageBackend";
import { getDb } from "../local/db";

export interface DirectMemoryOptions {
}

// ── Types ──────────────────────────────────────────────────────────────────

interface MemoryItem {
  id: string;
  content: string;
}

interface CommandConfig {
  name: string;
  type: "goal" | "fact";
  category: "goal" | "personal" | "preference" | "date";
  emoji: string;
  label: string;
}

const COMMAND_CONFIG: Record<string, CommandConfig> = {
  goals: {
    name: "goals",
    type: "goal",
    category: "goal",
    emoji: "🎯",
    label: "goal",
  },
  facts: {
    name: "facts",
    type: "fact",
    category: "personal",
    emoji: "📌",
    label: "fact",
  },
  prefs: {
    name: "prefs",
    type: "fact",
    category: "preference",
    emoji: "⚙️",
    label: "preference",
  },
  reminders: {
    name: "reminders",
    type: "fact",
    category: "date",
    emoji: "📅",
    label: "reminder",
  },
};

// ── List cache ─────────────────────────────────────────────────────────────
//
// Anchors numeric indices (*N, -N) to the list the user last viewed.
// Populated by listItems(); consumed (read-only) by findGoalsByIndexOrQuery()
// and findMatchingItems() for the numeric path.
//
// A single invalidation happens at the END of handleDirectMemoryCommand after
// all operations complete — preventing mid-command index shifts caused by
// mutations (e.g. toggleGoalDone changing type to completed_goal shifts the
// type="goal" query result for subsequent ops in the same command).

interface CachedList {
  items: MemoryItem[];
  expiresAt: number;
}

const listCache = new Map<string, CachedList>();
const LIST_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function listCacheKey(chatId: number, commandName: string): string {
  return `${chatId}:${commandName}`;
}

function setListCache(chatId: number, commandName: string, items: MemoryItem[]): void {
  listCache.set(listCacheKey(chatId, commandName), {
    items,
    expiresAt: Date.now() + LIST_CACHE_TTL_MS,
  });
}

function getListCache(chatId: number, commandName: string): MemoryItem[] | null {
  const key = listCacheKey(chatId, commandName);
  const entry = listCache.get(key);
  if (!entry || Date.now() >= entry.expiresAt) {
    listCache.delete(key);
    return null;
  }
  return entry.items;
}

function invalidateListCache(chatId: number, commandName: string): void {
  listCache.delete(listCacheKey(chatId, commandName));
}

// ── Pending duplicate confirmations ───────────────────────────────────────

interface PendingAdd {
  content: string;
  chatId: number;
  config: CommandConfig;
  expiresAt: number;
}

const pendingAdds = new Map<string, PendingAdd>();

// Evict expired entries every 60s
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingAdds) {
    if (now >= v.expiresAt) pendingAdds.delete(k);
  }
}, 60_000).unref();

// ── Parsing ────────────────────────────────────────────────────────────────

/**
 * Parse a command argument string with +/- items.
 *
 * Input:  "+goal1 | +goal2 | -old goal text | +goal3"
 * Output: { adds: ["goal1", "goal2", "goal3"], removes: ["old goal text"] }
 *
 * Items are pipe-separated. Leading +/- determines action.
 * Items without a prefix are ignored.
 */
export function parseAddRemoveArgs(input: string): {
  adds: string[];
  removes: string[];
  toggleDone: string[];
} {
  const adds: string[] = [];
  const removes: string[] = [];
  const toggleDone: string[] = [];

  // Split on pipe separator with optional surrounding whitespace
  const parts = input.split(/\s*\|\s*/);

  for (const raw of parts) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("+")) {
      const content = trimmed.slice(1).trim();
      if (content) adds.push(content);
    } else if (trimmed.startsWith("*")) {
      // *goal text → toggleDone: ["goal text"]
      // *1        → toggleDone: ["1"] (index-based)
      // * alone   → toggleDone: [""]  (list completed)
      const content = trimmed.slice(1).trim();
      toggleDone.push(content);
    } else if (trimmed.startsWith("-")) {
      const content = trimmed.slice(1).trim();
      if (content) removes.push(content);
    }
    // Items without +/-/* prefix are silently ignored
  }

  return { adds, removes, toggleDone };
}

// ── Text Normalization ─────────────────────────────────────────────────────

/**
 * Strip markdown inline formatting characters before substring comparison.
 *
 * Goals/facts stored via AI tags often contain backtick-wrapped terms
 * (e.g. `` `--system-prompt` ``) or bold/italic markers (`**`, `_`).
 * When a user types the same text without those markers the raw `.includes()`
 * check fails.  Normalising both sides makes removal/toggle reliable
 * regardless of how the content was originally formatted.
 *
 * Characters stripped: backtick, asterisk, underscore, tilde (strikethrough).
 * Whitespace is also collapsed so that "foo  bar" matches "foo bar".
 */
export function normalizeForSearch(text: string): string {
  return text
    .replace(/[`*_~]/g, "")   // strip inline markdown
    .replace(/\s+/g, " ")     // collapse whitespace
    .trim()
    .toLowerCase();
}

// ── Fuzzy Matching ─────────────────────────────────────────────────────────

/**
 * Find stored memory items that match a deletion query.
 *
 * Uses the SAME scope and category filters as listItems so that every item
 * visible to the user can also be deleted.  Previously this used strict
 * .eq("chat_id") + .eq("category") while listItems used .or() — meaning items
 * stored via [REMEMBER:] tags (category=null) or global items (chat_id=null)
 * appeared in /facts but could never be found for deletion, causing Ollama to
 * fire on the wrong candidate set and delete unrelated items.
 *
 * Strategy:
 * 1. Fetch candidates with the same scope as listItems
 * 2. ilike substring match first (fast, deterministic)
 * 3. Ollama semantic fallback only when ilike returns nothing
 */
async function findMatchingItems(
  chatId: number,
  config: CommandConfig,
  query: string
): Promise<MemoryItem[]> {
  const fetchCandidates = async (): Promise<MemoryItem[]> => {
    const db = getDb();
    let sql = "SELECT id, content FROM memory WHERE type = ? AND status = 'active'";
    const params: any[] = [config.type];

    if (config.name === "prefs" || config.name === "reminders") {
      sql += " AND category = ?";
      params.push(config.category);
    } else if (config.name === "facts") {
      sql += " AND (category = 'personal' OR category IS NULL)";
    }

    sql += " ORDER BY created_at ASC LIMIT 50";
    return db.query(sql).all(...params) as MemoryItem[];
  };

  // Index-based: check cache first
  if (/^\d+$/.test(query)) {
    let source = getListCache(chatId, config.name);
    if (source === null) {
      source = await fetchCandidates();
      if (source.length === 0) return [];
      setListCache(chatId, config.name, source);
    }
    const idx = parseInt(query, 10) - 1;
    if (idx >= 0 && idx < source.length) return [source[idx]];
    return [];
  }

  // Non-numeric: fetch candidates
  const data = await fetchCandidates();
  if (data.length === 0) return [];

  const candidates = data as MemoryItem[];

  // Strategy: substring match first (fast, reliable).
  // Ollama is used only as a semantic fallback when substring yields nothing,
  // e.g. user types "-that pm2 thing" to match "pm2 cron implementation".
  // This order fixes a bug where Ollama returned wrong indices (items 1,2)
  // causing the disambiguation keyboard to show completely unrelated items.
  //
  // Both sides are normalized (markdown stripped, whitespace collapsed) so that
  // a goal stored as "Use `--flag` for `claudeStream`" matches a query typed
  // as "--flag for claudeStream" without backticks.
  const queryNorm = normalizeForSearch(query);
  const substringMatches = candidates.filter((item) =>
    normalizeForSearch(item.content).includes(queryNorm)
  );

  if (substringMatches.length > 0) {
    return substringMatches;
  }

  // No substring match — try Claude Haiku semantic matching as fallback
  try {
    const numberedList = candidates
      .map((item, i) => `${i + 1}. "${item.content}"`)
      .join("\n");

    const prompt =
      `Given these stored items:\n${numberedList}\n\n` +
      `Which item(s) best match the deletion query: "${query}"?\n` +
      `Reply with ONLY comma-separated numbers (e.g. "1" or "2,3") or "none" if nothing matches.\n` +
      `Be lenient — partial or semantic matches count.`;

    const response = await claudeText(prompt, { timeoutMs: 8_000 });
    const indices = parseModelIndices(response, candidates.length);

    if (indices.length > 0) {
      return indices.map((i) => candidates[i]);
    }
  } catch {
    // Claude unavailable
  }

  return [];
}

// ── Delete helpers ─────────────────────────────────────────────────────────

/**
 * Delete a single memory item by ID.
 */
async function deleteItem(
  id: string
): Promise<boolean> {
  try {
    await deleteMemoryRecord(id);
    return true;
  } catch {
    return false;
  }
}

// ── List helper ────────────────────────────────────────────────────────────

/**
 * Fetch and format all stored items for a given type+category.
 * Returns formatted text ready to send.
 *
 * Scoping: includes both chat-specific (chat_id=chatId) and global (chat_id=null)
 * items, matching the behaviour of /memory goals and /memory facts.
 *
 * Category filtering:
 *   goals     — no category filter (items may have category=null from [GOAL:] tags)
 *   facts     — category='personal' OR category IS NULL (excludes dates/prefs)
 *   prefs     — category='preference'
 *   reminders — category='date'
 */
async function listItems(
  chatId: number,
  config: CommandConfig
): Promise<string> {
  const usageHint = config.name === "goals"
    ? `\nUse /${config.name} +item | -N | *N  (pipe-separate multiple ops)`
    : `\nUse /${config.name} +item | -N or -text  (pipe-separate multiple ops)`;

  let items: Array<{ id: string; content: string; chat_id?: any; thread_id?: any }> = [];

  const db = getDb();
  let sql = "SELECT id, content, chat_id, thread_id FROM memory WHERE type = ? AND status = 'active'";
  const params: any[] = [config.type];

  if (config.name === "prefs" || config.name === "reminders") {
    sql += " AND category = ?";
    params.push(config.category);
  } else if (config.name === "facts") {
    sql += " AND (category = 'personal' OR category IS NULL)";
  }

  // Scope to this chat + global items
  sql += " AND (chat_id = ? OR chat_id IS NULL)";
  params.push(chatId);

  sql += " ORDER BY created_at ASC LIMIT 50";
  items = db.query(sql).all(...params) as any[];

  if (items.length === 0) {
    return `No ${config.label}s stored yet.${usageHint}`;
  }

  setListCache(chatId, config.name, items as MemoryItem[]);

  const lines = items.map((item, i) => {
    const src = resolveSourceLabel(item.chat_id, item.thread_id);
    return `  ${i + 1}. ${item.content} [${src}]`;
  }).join("\n");
  return `${config.emoji} ${config.label.charAt(0).toUpperCase() + config.label.slice(1)}s\n${"─".repeat(24)}\n${lines}${usageHint}`;
}

// ── Goal done helpers ─────────────────────────────────────────────────────

/**
 * Find active goals by 1-based index or substring/semantic query.
 */
async function findGoalsByIndexOrQuery(
  chatId: number,
  query: string
): Promise<MemoryItem[]> {
  if (query === "") return []; // caller handles "list completed" path

  const fetchGoals = async (): Promise<MemoryItem[]> => {
    const db = getDb();
    return db.query(
      "SELECT id, content FROM memory WHERE type = 'goal' AND status = 'active' AND (chat_id = ? OR chat_id IS NULL) ORDER BY created_at ASC LIMIT 50"
    ).all(chatId) as MemoryItem[];
  };

  if (/^\d+$/.test(query)) {
    let source = getListCache(chatId, "goals");
    if (source === null) {
      source = await fetchGoals();
      if (source.length === 0) return [];
      setListCache(chatId, "goals", source);
    }
    const idx = parseInt(query, 10) - 1;
    if (idx >= 0 && idx < source.length) return [source[idx]];
    return [];
  }

  const goals = await fetchGoals();
  if (goals.length === 0) return [];

  // Substring match — normalize both sides to strip markdown formatting
  // (backticks, asterisks, underscores) so a goal stored as "`--flag`"
  // is found when the user types "--flag" without backticks.
  const queryNorm = normalizeForSearch(query);
  const substringMatches = goals.filter((g) =>
    normalizeForSearch(g.content).includes(queryNorm)
  );
  if (substringMatches.length > 0) return substringMatches;

  // Claude Haiku semantic fallback (same pattern as findMatchingItems)
  try {
    const numberedList = goals
      .map((g, i) => `${i + 1}. "${g.content}"`)
      .join("\n");

    const prompt =
      `Given these goals:\n${numberedList}\n\n` +
      `Which goal(s) best match: "${query}"?\n` +
      `Reply with ONLY comma-separated numbers (e.g. "1" or "2,3") or "none" if nothing matches.\n` +
      `Be lenient — partial or semantic matches count.`;

    const response = await claudeText(prompt, { timeoutMs: 8_000 });
    const indices = parseModelIndices(response, goals.length);

    if (indices.length > 0) return indices.map((i) => goals[i]);
  } catch {
    // Claude unavailable — no matches
  }

  return [];
}

/**
 * Toggle a goal between active and completed.
 * Returns whether the goal was previously active (i.e., just marked done).
 */
async function toggleGoalDone(
  id: string
): Promise<{ wasActive: boolean }> {
  const db = getDb();
  const row = db.query("SELECT type FROM memory WHERE id = ?").get(id) as { type: string } | null;
  if (!row) throw new Error("Goal not found");
  const currentType = row.type;

  if (currentType === "goal") {
    await updateMemoryRecord(id, {
      type: "completed_goal",
      completed_at: new Date().toISOString(),
    });
    return { wasActive: true };
  } else {
    await updateMemoryRecord(id, {
      type: "goal",
      completed_at: null,
    });
    return { wasActive: false };
  }
}

/**
 * List completed/archived goals for a chat, split by recency.
 */
async function listCompletedGoals(
  chatId: number
): Promise<string> {
  const db = getDb();
  const data = db.query(
    "SELECT id, content, completed_at, chat_id, thread_id FROM memory WHERE type = 'completed_goal' AND (chat_id = ? OR chat_id IS NULL) ORDER BY completed_at DESC LIMIT 50"
  ).all(chatId) as any[];

  if (data.length === 0) {
    return "No completed goals yet.\n\nMark a goal as done with /goals *N or /goals *text";
  }

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const recent: typeof data = [];
  const archived: typeof data = [];

  for (const item of data) {
    const completedDate = item.completed_at ? new Date(item.completed_at) : null;
    if (completedDate && completedDate < thirtyDaysAgo) {
      archived.push(item);
    } else {
      recent.push(item);
    }
  }

  const parts: string[] = [];
  let counter = 1;

  if (recent.length > 0) {
    const lines = recent.map((g) => {
      const when = g.completed_at
        ? new Date(g.completed_at).toLocaleDateString("en-SG", { day: "numeric", month: "short" })
        : "";
      const src = resolveSourceLabel(g.chat_id, g.thread_id);
      return `  ${counter++}. ${g.content}${when ? ` (done ${when})` : ""} [${src}]`;
    }).join("\n");
    parts.push(`✅ Done\n${"─".repeat(24)}\n${lines}`);
  }

  if (archived.length > 0) {
    const lines = archived.map((g) => {
      const when = g.completed_at
        ? new Date(g.completed_at).toLocaleDateString("en-SG", { day: "numeric", month: "short", year: "numeric" })
        : "";
      const src = resolveSourceLabel(g.chat_id, g.thread_id);
      return `  ${counter++}. ${g.content}${when ? ` (done ${when})` : ""} [${src}]`;
    }).join("\n");
    parts.push(`📦 Archived (30+ days ago)\n${"─".repeat(24)}\n${lines}`);
  }

  parts.push("Use /goals *N or /goals *text to toggle goals.");

  return parts.join("\n\n");
}

// ── Reply helpers ──────────────────────────────────────────────────────────

/**
 * Send a reply, splitting into multiple messages if the text exceeds
 * Telegram's 4096-character limit. Uses the same chunking strategy as
 * sendToGroup (paragraph → line → hard-split).
 */
async function replyChunked(ctx: Context, text: string): Promise<void> {
  for (const chunk of chunkMessage(text)) {
    await ctx.reply(chunk);
  }
}

// ── Command handler ────────────────────────────────────────────────────────

/**
 * Handle one of the four direct memory commands.
 * Returns the bot reply text (for saving to STM).
 */
async function handleDirectMemoryCommand(
  ctx: Context,
  config: CommandConfig
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const input = (ctx.match ?? "").trim();

  if (!input) {
    const replyText = await listItems(chatId, config);
    await replyChunked(ctx, replyText);
    await saveCommandInteraction(chatId, `/${config.name}`, replyText);
    return;
  }

  const { adds, removes, toggleDone } = parseAddRemoveArgs(input);

  // Track whether any mutation occurred so we can do a single cache invalidation
  // at the END of the command rather than mid-command. Mid-command invalidation
  // causes subsequent numeric ops to re-query the DB and get a shifted list.
  let mutationOccurred = false;

  // ── Handle * syntax (goals only) ────────────────────────────────────────
  if (config.name === "goals" && toggleDone.length > 0) {
    // "/goals *" alone → list completed goals
    if (toggleDone.length === 1 && toggleDone[0] === "") {
      const replyText = await listCompletedGoals(chatId);
      await replyChunked(ctx, replyText);
      await saveCommandInteraction(chatId, `/${config.name} *`, replyText);
      return;
    }

    const results: string[] = [];

    for (const query of toggleDone) {
      if (query === "") continue; // skip empty from mixed input like "+add, *"
      try {
        const matches = await findGoalsByIndexOrQuery(chatId, query);

        if (matches.length === 0) {
          results.push(`❓ Not found: "${query}"`);
          continue;
        }

        if (matches.length === 1) {
          const { wasActive } = await toggleGoalDone(matches[0].id);
          mutationOccurred = true;
          if (wasActive) {
            results.push(`✅ Marked as done: ${matches[0].content}`);
          } else {
            results.push(`♻️ Reactivated: ${matches[0].content}`);
          }
          continue;
        }

        // Multiple matches — disambiguation keyboard
        const keyboard = new InlineKeyboard();
        for (const match of matches.slice(0, 4)) {
          keyboard
            .text(
              `✅ ${match.content.slice(0, 28)}`,
              `dmem_done:${match.id}`
            )
            .row();
        }
        keyboard.text("❌ Cancel", "dmem_cancel");

        await ctx.reply(
          `Multiple goals match "${query}". Which one to mark done?`,
          { reply_markup: keyboard }
        );
      } catch (err) {
        results.push(`❌ Error toggling "${query}"`);
        console.error(`[directMemory] toggle error:`, err);
      }
    }

    if (results.length > 0) {
      const replyText = results.join("\n");
      await replyChunked(ctx, replyText);
      await saveCommandInteraction(chatId, `/${config.name} ${input}`, replyText);
    }

    // If there are also +/- items mixed in, fall through to process them
    if (adds.length === 0 && removes.length === 0) return;
  }

  if (adds.length === 0 && removes.length === 0) {
    await ctx.reply(
      `No valid items found. Use + to add and - to remove.\n` +
        `Example: /${config.name} +Item to add | -Item to remove`
    );
    return;
  }

  const results: string[] = [];

  // ── Process additions (with duplicate detection) ────────────────────────
  for (const content of adds) {
    try {
      // Check for semantic duplicates before inserting.
      const db = getDb();
      let sql = "SELECT id, content FROM memory WHERE type = ? AND status = 'active'";
      const params: any[] = [config.type];
      if (config.name === "prefs" || config.name === "reminders") {
        sql += " AND category = ?";
        params.push(config.category);
      } else if (config.name === "facts") {
        sql += " AND (category = 'personal' OR category IS NULL)";
      }
      sql += " ORDER BY created_at ASC LIMIT 50";
      const existingItems = db.query(sql).all(...params) as { id: string; content: string }[];

      const duplicates = await findPotentialDuplicates(
        existingItems,
        content
      );

      if (duplicates.length > 0) {
        // Show confirmation keyboard instead of inserting
        const key = crypto.randomUUID().slice(0, 8);
        pendingAdds.set(key, {
          content,
          chatId,
          config,
          expiresAt: Date.now() + 5 * 60 * 1000, // 5 min TTL
        });

        const dupList = duplicates
          .map((d) => `  - ${d.content}`)
          .join("\n");

        const keyboard = new InlineKeyboard()
          .text("✅ Yes, add it anyway", `dmem_dup_yes:${key}`)
          .row()
          .text("❌ No, skip", `dmem_dup_no:${key}`);

        await ctx.reply(
          `⚠️ Similar item(s) already exist:\n${dupList}\n\nStill add "${content}"?`,
          { reply_markup: keyboard }
        );
        continue;
      }

      const threadId = ctx.message?.message_thread_id ?? null;
      const { error } = await insertMemoryRecord({
        type: config.type,
        content,
        chat_id: chatId,
        thread_id: threadId,
        category: config.category,
        extracted_from_exchange: false,
        confidence: 1.0,
      });

      if (error) {
        results.push(`❌ Failed to add: ${content}`);
      } else {
        mutationOccurred = true;
        results.push(`${config.emoji} Added: ${content}`);
      }
    } catch {
      results.push(`❌ Error adding: ${content}`);
    }
  }

  // ── Process removals ───────────────────────────────────────────────────
  for (const query of removes) {
    try {
      const matches = await findMatchingItems(chatId, config, query);

      if (matches.length === 0) {
        results.push(`❓ Not found: "${query}"`);
        continue;
      }

      if (matches.length === 1) {
        // Single match — delete immediately
        const ok = await deleteItem(matches[0].id);
        if (ok) {
          mutationOccurred = true;
          results.push(`🗑️ Removed: ${matches[0].content}`);
        } else {
          results.push(`❌ Failed to remove: ${matches[0].content}`);
        }
        continue;
      }

      // Multiple matches — ask user to confirm
      const keyboard = new InlineKeyboard();
      for (const match of matches.slice(0, 4)) {
        keyboard
          .text(
            match.content.slice(0, 32),
            `dmem_del:${match.id}`
          )
          .row();
      }
      keyboard.text("❌ Cancel", "dmem_cancel");

      await ctx.reply(
        `Multiple matches for "${query}". Which one to remove?`,
        { reply_markup: keyboard }
      );
      // Don't add to results — user will confirm via callback
    } catch (err) {
      results.push(`❌ Error removing "${query}"`);
      console.error(`[directMemory] remove error:`, err);
    }
  }

  if (results.length > 0) {
    const replyText = results.join("\n");
    await replyChunked(ctx, replyText);

    // Save to short-term memory
    await saveCommandInteraction(
      chatId,
      `/${config.name} ${input}`,
      replyText
    );
  }

  // Single cache invalidation after ALL operations complete.
  // This keeps the cache stable for every op within the command while ensuring
  // the next list command (or next *N command) gets a fresh DB result.
  if (mutationOccurred) {
    invalidateListCache(chatId, config.name);
  }
}

// ── Registration ───────────────────────────────────────────────────────────

/**
 * Register /goals, /facts, /prefs, /reminders commands and their callbacks.
 */
export function registerDirectMemoryCommands(
  bot: Bot,
  _options: DirectMemoryOptions
): void {
  for (const [cmdName, config] of Object.entries(COMMAND_CONFIG)) {
    bot.command(cmdName, async (ctx) => {
      await handleDirectMemoryCommand(ctx, config);
    });
  }

  // Callback: delete a specific item
  bot.callbackQuery(/^dmem_del:/, async (ctx) => {
    const itemId = ctx.callbackQuery.data.replace("dmem_del:", "");
    try {
      await deleteMemoryRecord(itemId);
      await ctx.editMessageText("🗑️ Removed.");
      await ctx.answerCallbackQuery("Removed");
    } catch {
      await ctx.answerCallbackQuery("Failed");
    }
  });

  // Callback: mark goal as done (toggle)
  bot.callbackQuery(/^dmem_done:/, async (ctx) => {
    const goalId = ctx.callbackQuery.data.replace("dmem_done:", "");
    try {
      // Fetch content for the response message
      const db = getDb();
      const row = db.query("SELECT content FROM memory WHERE id = ?").get(goalId) as { content: string } | null;
      const content = row?.content ?? "goal";

      const { wasActive } = await toggleGoalDone(goalId);
      if (wasActive) {
        await ctx.editMessageText(`✅ Marked as done: ${content}`);
        await ctx.answerCallbackQuery("Done!");
      } else {
        await ctx.editMessageText(`♻️ Reactivated: ${content}`);
        await ctx.answerCallbackQuery("Reactivated");
      }
    } catch {
      await ctx.answerCallbackQuery("Failed");
    }
  });

  // Callback: confirm duplicate add
  bot.callbackQuery(/^dmem_dup_yes:/, async (ctx) => {
    const key = ctx.callbackQuery.data.replace("dmem_dup_yes:", "");
    const pending = pendingAdds.get(key);
    if (!pending) {
      await ctx.editMessageText("Expired. Please try again.");
      await ctx.answerCallbackQuery("Expired");
      return;
    }
    pendingAdds.delete(key);

    try {
      const { error } = await insertMemoryRecord({
        type: pending.config.type,
        content: pending.content,
        chat_id: pending.chatId,
        category: pending.config.category,
        extracted_from_exchange: false,
        confidence: 1.0,
      });

      if (error) {
        await ctx.editMessageText(`❌ Failed to add: ${pending.content}`);
      } else {
        await ctx.editMessageText(`${pending.config.emoji} Added: ${pending.content}`);
      }
      await ctx.answerCallbackQuery("Added");
    } catch {
      await ctx.answerCallbackQuery("Failed");
    }
  });

  // Callback: skip duplicate add
  bot.callbackQuery(/^dmem_dup_no:/, async (ctx) => {
    const key = ctx.callbackQuery.data.replace("dmem_dup_no:", "");
    pendingAdds.delete(key);
    await ctx.editMessageText("Skipped.");
    await ctx.answerCallbackQuery("Skipped");
  });

  // Callback: cancel deletion
  bot.callbackQuery("dmem_cancel", async (ctx) => {
    await ctx.editMessageText("Cancelled.");
    await ctx.answerCallbackQuery("Cancelled");
  });
}
