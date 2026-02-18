/**
 * Direct Memory Mutation Commands
 *
 * Adds four commands for explicit memory management with +/- syntax:
 *   /goals  +goal1, +goal2, -old goal text
 *   /facts  +fact1, -old fact
 *   /prefs  +prefer X, -old preference
 *   /reminders +Meeting Friday 3pm, -old reminder
 *
 * - `+item` adds a new entry
 * - `-item` removes matching entry using Ollama fuzzy match (fallback: ilike)
 * - Question UI (InlineKeyboard) is shown when multiple candidates match
 */

import type { Bot, Context } from "grammy";
import type { SupabaseClient } from "@supabase/supabase-js";
import { InlineKeyboard } from "grammy";
import { callClaudeText } from "../claude.ts";
import { saveCommandInteraction } from "../utils/saveMessage.ts";

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
} {
  const adds: string[] = [];
  const removes: string[] = [];

  // Split on commas, but be careful not to split within items
  // Strategy: split on ", +" or ", -" boundaries
  // First normalize: split on comma + optional whitespace
  const parts = input.split(/,\s*/);

  for (const raw of parts) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("+")) {
      const content = trimmed.slice(1).trim();
      if (content) adds.push(content);
    } else if (trimmed.startsWith("-")) {
      const content = trimmed.slice(1).trim();
      if (content) removes.push(content);
    }
    // Items without +/- prefix are silently ignored
  }

  return { adds, removes };
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
  // Build query with the same scope as listItems
  const scope = `chat_id.eq.${chatId},chat_id.is.null`;
  let baseQuery = supabase
    .from("memory")
    .select("id, content")
    .or(scope)
    .eq("type", config.type);

  if (config.name === "prefs" || config.name === "reminders") {
    // Strict category filter — these buckets are well-defined
    baseQuery = baseQuery.eq("category", config.category);
  } else if (config.name === "facts") {
    // Match items shown by /facts: personal + uncategorised (from [REMEMBER:] tags)
    baseQuery = baseQuery.or("category.eq.personal,category.is.null");
  }
  // goals: no category filter — same as listItems

  const { data, error } = await baseQuery.limit(20);

  if (error || !data || data.length === 0) return [];

  const candidates = data as MemoryItem[];

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

    const response = await callClaudeText(prompt, { timeoutMs: 8_000 });
    const raw = response.trim().toLowerCase();

    if (raw === "none" || !raw) return [];

    const indices = raw
      .split(",")
      .map((s) => parseInt(s.trim(), 10) - 1)
      .filter((i) => i >= 0 && i < candidates.length);

    if (indices.length > 0) {
      return indices.map((i) => candidates[i]);
    }
  } catch {
    // Ollama unavailable
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
  const scope = `chat_id.eq.${chatId},chat_id.is.null`;

  let query = supabase
    .from("memory")
    .select("id, content")
    .or(scope)
    .eq("type", config.type);

  if (config.name === "prefs" || config.name === "reminders") {
    // Strict category filter for prefs and reminders
    query = query.eq("category", config.category);
  } else if (config.name === "facts") {
    // Include personal facts and uncategorised items; exclude dates and prefs
    query = query.or("category.eq.personal,category.is.null");
  }
  // goals: no category filter — includes items stored via [GOAL:] intent tags

  const usageHint =
    `\nUse /${config.name} +item to add, -item to remove.`;

  const { data, error } = await query
    .order("created_at", { ascending: true })
    .limit(50);

  if (error || !data || data.length === 0) {
    return `No ${config.label}s stored yet.${usageHint}`;
  }

  const lines = (data as MemoryItem[]).map((item) => `  • ${item.content}`).join("\n");
  return `${config.emoji} ${config.label.charAt(0).toUpperCase() + config.label.slice(1)}s\n${"─".repeat(24)}\n${lines}${usageHint}`;
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

  const { adds, removes } = parseAddRemoveArgs(input);

  if (adds.length === 0 && removes.length === 0) {
    await ctx.reply(
      `No valid items found. Use + to add and - to remove.\n` +
        `Example: /${config.name} +Item to add, -Item to remove`
    );
    return;
  }

  const results: string[] = [];

  // ── Process additions ──────────────────────────────────────────────────
  for (const content of adds) {
    try {
      const { error } = await supabase.from("memory").insert({
        type: config.type,
        content,
        chat_id: chatId,
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

  // Callback: cancel deletion
  bot.callbackQuery("dmem_cancel", async (ctx) => {
    await ctx.editMessageText("Cancelled.");
    await ctx.answerCallbackQuery("Cancelled");
  });
}
