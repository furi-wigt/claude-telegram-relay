/**
 * Direct Memory Mutation Commands
 *
 * Adds four commands for explicit memory management with +/- syntax:
 *   /goals  +goal1, +goal2, -old goal text
 *   /goals  *goal1, *2  — mark goal as done (index or fuzzy match)
 *   /goals  *           — list completed/archived goals
 *   /facts  +fact1, -old fact
 *   /prefs  +prefer X, -old preference
 *   /reminders +Meeting Friday 3pm, -old reminder
 *
 * - `+item` adds a new entry
 * - `-item` removes matching entry using Ollama fuzzy match (fallback: ilike)
 * - `*item` or `*N` marks matching goal as done/undone (toggle)
 * - Question UI (InlineKeyboard) is shown when multiple candidates match
 */

import type { Bot, Context } from "grammy";
import type { SupabaseClient } from "@supabase/supabase-js";
import { InlineKeyboard } from "grammy";
import { claudeText } from "../claude-process.ts";
import { saveCommandInteraction } from "../utils/saveMessage.ts";
import { findPotentialDuplicates, parseModelIndices } from "../utils/duplicateDetector.ts";

export interface DirectMemoryOptions {
  supabase: SupabaseClient | null;
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
 * Input:  "+goal1, +goal2, -old goal text, +goal3"
 * Output: { adds: ["goal1", "goal2", "goal3"], removes: ["old goal text"] }
 *
 * Items are comma-separated. Leading +/- determines action.
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

  // Split on commas, but be careful not to split within items
  // Strategy: split on ", +" or ", -" boundaries
  // First normalize: split on comma + optional whitespace
  const parts = input.split(/,\s*/);

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
  supabase: SupabaseClient,
  chatId: number,
  config: CommandConfig,
  query: string
): Promise<MemoryItem[]> {
  // Build query with the same scope as listItems.
  // Goals are globally scoped (no chatId filter); other types are chat-scoped.
  const scope = `chat_id.eq.${chatId},chat_id.is.null`;
  let baseQuery = supabase
    .from("memory")
    .select("id, content")
    .eq("type", config.type);

  if (config.type !== "goal") {
    baseQuery = (baseQuery as any).or(scope);
  }

  if (config.name === "prefs" || config.name === "reminders") {
    // Strict category filter — these buckets are well-defined
    baseQuery = baseQuery.eq("category", config.category);
  } else if (config.name === "facts") {
    // Match items shown by /facts: personal + uncategorised (from [REMEMBER:] tags)
    baseQuery = baseQuery.or("category.eq.personal,category.is.null");
  }
  // goals: no category filter — same as listItems

  const { data, error } = await baseQuery
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(50);

  if (error || !data || data.length === 0) return [];

  const candidates = data as MemoryItem[];

  // Index-based: purely numeric query like "1", "2"
  if (/^\d+$/.test(query)) {
    const idx = parseInt(query, 10) - 1;
    if (idx >= 0 && idx < candidates.length) return [candidates[idx]];
    return []; // out of range
  }

  // Strategy: substring match first (fast, reliable).
  // Ollama is used only as a semantic fallback when substring yields nothing,
  // e.g. user types "-that pm2 thing" to match "pm2 cron implementation".
  // This order fixes a bug where Ollama returned wrong indices (items 1,2)
  // causing the disambiguation keyboard to show completely unrelated items.
  const queryLower = query.toLowerCase();
  const substringMatches = candidates.filter((item) =>
    item.content.toLowerCase().includes(queryLower)
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
  supabase: SupabaseClient,
  id: string
): Promise<boolean> {
  const { error } = await supabase.from("memory").delete().eq("id", id);
  return !error;
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
  supabase: SupabaseClient,
  chatId: number,
  config: CommandConfig
): Promise<string> {
  // Goals are globally scoped — never filter by chatId.
  // Facts, prefs, and reminders are chat-scoped.
  const scope = `chat_id.eq.${chatId},chat_id.is.null`;

  let query = supabase
    .from("memory")
    .select("id, content")
    .eq("type", config.type);

  if (config.type !== "goal") {
    query = (query as any).or(scope);
  }

  if (config.name === "prefs" || config.name === "reminders") {
    // Strict category filter for prefs and reminders
    query = query.eq("category", config.category);
  } else if (config.name === "facts") {
    // Include personal facts and uncategorised items; exclude dates and prefs
    query = query.or("category.eq.personal,category.is.null");
  }
  // goals: no category filter — includes items stored via [GOAL:] intent tags

  const usageHint = config.name === "goals"
    ? `\nUse /${config.name} +item to add, -N or -text to remove, *N or *text to mark done.`
    : `\nUse /${config.name} +item to add, -N or -text to remove.`;

  const { data, error } = await query
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(50);

  if (error || !data || data.length === 0) {
    return `No ${config.label}s stored yet.${usageHint}`;
  }

  // Number all items for index-based addressing (-1, -2, etc.)
  const lines = (data as MemoryItem[]).map((item, i) => `  ${i + 1}. ${item.content}`).join("\n");
  return `${config.emoji} ${config.label.charAt(0).toUpperCase() + config.label.slice(1)}s\n${"─".repeat(24)}\n${lines}${usageHint}`;
}

// ── Goal done helpers ─────────────────────────────────────────────────────

/**
 * Find active goals by 1-based index or substring/semantic query.
 */
async function findGoalsByIndexOrQuery(
  supabase: SupabaseClient,
  chatId: number,
  query: string
): Promise<MemoryItem[]> {
  if (query === "") return []; // caller handles "list completed" path

  // Goals are globally scoped — fetch all goals regardless of which group created them.
  const { data, error } = await supabase
    .from("memory")
    .select("id, content")
    .eq("type", "goal")
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(50);

  if (error || !data || data.length === 0) return [];

  const goals = data as MemoryItem[];

  // Index-based: purely numeric query like "1", "2"
  if (/^\d+$/.test(query)) {
    const idx = parseInt(query, 10) - 1;
    if (idx >= 0 && idx < goals.length) return [goals[idx]];
    return [];
  }

  // Substring match
  const queryLower = query.toLowerCase();
  const substringMatches = goals.filter((g) =>
    g.content.toLowerCase().includes(queryLower)
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
  supabase: SupabaseClient,
  id: string
): Promise<{ wasActive: boolean }> {
  const { data, error } = await supabase
    .from("memory")
    .select("type")
    .eq("id", id)
    .single();

  if (error || !data) throw new Error("Goal not found");

  if (data.type === "goal") {
    await supabase
      .from("memory")
      .update({ type: "completed_goal", completed_at: new Date().toISOString() })
      .eq("id", id);
    return { wasActive: true };
  } else {
    await supabase
      .from("memory")
      .update({ type: "goal", completed_at: null })
      .eq("id", id);
    return { wasActive: false };
  }
}

/**
 * List completed/archived goals for a chat, split by recency.
 */
async function listCompletedGoals(
  supabase: SupabaseClient,
  chatId: number
): Promise<string> {
  // Goals are globally scoped — list completed goals from all groups.
  const { data, error } = await supabase
    .from("memory")
    .select("id, content, completed_at")
    .eq("type", "completed_goal")
    .order("completed_at", { ascending: false })
    .limit(50);

  if (error || !data || data.length === 0) {
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
      return `  ${counter++}. ${g.content}${when ? ` (done ${when})` : ""}`;
    }).join("\n");
    parts.push(`✅ Done\n${"─".repeat(24)}\n${lines}`);
  }

  if (archived.length > 0) {
    const lines = archived.map((g) => {
      const when = g.completed_at
        ? new Date(g.completed_at).toLocaleDateString("en-SG", { day: "numeric", month: "short", year: "numeric" })
        : "";
      return `  ${counter++}. ${g.content}${when ? ` (done ${when})` : ""}`;
    }).join("\n");
    parts.push(`📦 Archived (30+ days ago)\n${"─".repeat(24)}\n${lines}`);
  }

  parts.push("Use /goals *N or /goals *text to toggle goals.");

  return parts.join("\n\n");
}

// ── Command handler ────────────────────────────────────────────────────────

/**
 * Handle one of the four direct memory commands.
 * Returns the bot reply text (for saving to STM).
 */
async function handleDirectMemoryCommand(
  ctx: Context,
  supabase: SupabaseClient,
  config: CommandConfig
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const input = (ctx.match ?? "").trim();

  if (!input) {
    const replyText = await listItems(supabase, chatId, config);
    await ctx.reply(replyText);
    await saveCommandInteraction(supabase, chatId, `/${config.name}`, replyText);
    return;
  }

  const { adds, removes, toggleDone } = parseAddRemoveArgs(input);

  // ── Handle * syntax (goals only) ────────────────────────────────────────
  if (config.name === "goals" && toggleDone.length > 0) {
    // "/goals *" alone → list completed goals
    if (toggleDone.length === 1 && toggleDone[0] === "") {
      const replyText = await listCompletedGoals(supabase, chatId);
      await ctx.reply(replyText);
      await saveCommandInteraction(supabase, chatId, `/${config.name} *`, replyText);
      return;
    }

    const results: string[] = [];

    for (const query of toggleDone) {
      if (query === "") continue; // skip empty from mixed input like "+add, *"
      try {
        const matches = await findGoalsByIndexOrQuery(supabase, chatId, query);

        if (matches.length === 0) {
          results.push(`❓ Not found: "${query}"`);
          continue;
        }

        if (matches.length === 1) {
          const { wasActive } = await toggleGoalDone(supabase, matches[0].id);
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
      await ctx.reply(replyText);
      await saveCommandInteraction(supabase, chatId, `/${config.name} ${input}`, replyText);
    }

    // If there are also +/- items mixed in, fall through to process them
    if (adds.length === 0 && removes.length === 0) return;
  }

  if (adds.length === 0 && removes.length === 0) {
    await ctx.reply(
      `No valid items found. Use + to add and - to remove.\n` +
        `Example: /${config.name} +Item to add, -Item to remove`
    );
    return;
  }

  const results: string[] = [];

  // ── Process additions (with duplicate detection) ────────────────────────
  for (const content of adds) {
    try {
      // Check for semantic duplicates before inserting
      const scope = `chat_id.eq.${chatId},chat_id.is.null`;
      let existingQuery = supabase
        .from("memory")
        .select("id, content")
        .or(scope)
        .eq("type", config.type);

      if (config.name === "prefs" || config.name === "reminders") {
        existingQuery = existingQuery.eq("category", config.category);
      } else if (config.name === "facts") {
        existingQuery = existingQuery.or("category.eq.personal,category.is.null");
      }

      const { data: existingItems } = await existingQuery
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(50);

      const duplicates = await findPotentialDuplicates(
        (existingItems ?? []) as { id: string; content: string }[],
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

      const { error } = await supabase.from("memory").insert({
        type: config.type,
        content,
        // Goals are globally scoped — visible across all groups regardless of where they were created.
        chat_id: config.type === "goal" ? null : chatId,
        category: config.category,
        extracted_from_exchange: false,
        confidence: 1.0,
      });

      if (error) {
        results.push(`❌ Failed to add: ${content}`);
      } else {
        results.push(`${config.emoji} Added: ${content}`);
      }
    } catch {
      results.push(`❌ Error adding: ${content}`);
    }
  }

  // ── Process removals ───────────────────────────────────────────────────
  for (const query of removes) {
    try {
      const matches = await findMatchingItems(supabase, chatId, config, query);

      if (matches.length === 0) {
        results.push(`❓ Not found: "${query}"`);
        continue;
      }

      if (matches.length === 1) {
        // Single match — delete immediately
        const ok = await deleteItem(supabase, matches[0].id);
        if (ok) {
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
    await ctx.reply(replyText);

    // Save to short-term memory
    await saveCommandInteraction(
      supabase,
      chatId,
      `/${config.name} ${input}`,
      replyText
    );
  }
}

// ── Registration ───────────────────────────────────────────────────────────

/**
 * Register /goals, /facts, /prefs, /reminders commands and their callbacks.
 */
export function registerDirectMemoryCommands(
  bot: Bot,
  options: DirectMemoryOptions
): void {
  const { supabase } = options;

  for (const [cmdName, config] of Object.entries(COMMAND_CONFIG)) {
    bot.command(cmdName, async (ctx) => {
      if (!supabase) {
        await ctx.reply("Memory is not configured (Supabase not set up).");
        return;
      }
      await handleDirectMemoryCommand(ctx, supabase, config);
    });
  }

  // Callback: delete a specific item
  bot.callbackQuery(/^dmem_del:/, async (ctx) => {
    if (!supabase) {
      await ctx.answerCallbackQuery("Not configured");
      return;
    }
    const itemId = ctx.callbackQuery.data.replace("dmem_del:", "");
    try {
      await supabase.from("memory").delete().eq("id", itemId);
      await ctx.editMessageText("🗑️ Removed.");
      await ctx.answerCallbackQuery("Removed");
    } catch {
      await ctx.answerCallbackQuery("Failed");
    }
  });

  // Callback: mark goal as done (toggle)
  bot.callbackQuery(/^dmem_done:/, async (ctx) => {
    if (!supabase) {
      await ctx.answerCallbackQuery("Not configured");
      return;
    }
    const goalId = ctx.callbackQuery.data.replace("dmem_done:", "");
    try {
      // Fetch content for the response message
      const { data } = await supabase
        .from("memory")
        .select("content")
        .eq("id", goalId)
        .single();
      const content = data?.content ?? "goal";

      const { wasActive } = await toggleGoalDone(supabase, goalId);
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
    if (!supabase) {
      await ctx.answerCallbackQuery("Not configured");
      return;
    }
    const key = ctx.callbackQuery.data.replace("dmem_dup_yes:", "");
    const pending = pendingAdds.get(key);
    if (!pending) {
      await ctx.editMessageText("Expired. Please try again.");
      await ctx.answerCallbackQuery("Expired");
      return;
    }
    pendingAdds.delete(key);

    try {
      const { error } = await supabase.from("memory").insert({
        type: pending.config.type,
        content: pending.content,
        chat_id: pending.config.type === "goal" ? null : pending.chatId,
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
