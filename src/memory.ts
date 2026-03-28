/**
 * Memory Module
 *
 * Persistent facts and goals stored in local SQLite + Qdrant.
 * Claude manages memory automatically via intent tags in its responses:
 *   [REMEMBER: fact]
 *   [REMEMBER_GLOBAL: fact]
 *   [GOAL: text | DEADLINE: date]
 *   [DONE: search text]
 *
 * The relay parses these tags, checks for semantic duplicates via
 * Qdrant vector search, saves to SQLite (skipping near-exact duplicates),
 * and strips tags from the response before sending to the user.
 *
 * Memory is GLOBAL — reads return all facts and goals regardless of
 * which chat created them. The chat_id column is retained on writes
 * for audit traceability only.
 */

import { isJunkMemoryContent } from "./memory/junkFilter.ts";
import { getDb } from "./local/db.ts";
import { resolveSourceLabel } from "./utils/chatNames.ts";
import { checkSemanticDuplicate } from "./utils/semanticDuplicateChecker.ts";
import { isTextDuplicateGoal, isTextDuplicate } from "./utils/goalDuplicateChecker.ts";
import { getMemoryScores, rebuildProfileSummary } from "./memory/longTermExtractor.ts";
import {
  incrementProfileRebuildCounter,
  resetProfileRebuildCounter,
} from "./memory/profileRebuildCounter.ts";
import {
  insertMemoryRecord,
  updateMemoryRecord,
  findGoalByContent,
  getExistingMemories,
  getMemoryFacts,
  getMemoryGoals,
  touchMemoryAccess,
  semanticSearchMemory,
  semanticSearchMessages,
  getAllMemoryForDisplay,
} from "./local/storageBackend";

/** Generic command patterns that carry zero domain signal — skip Q: prefix for these */
export const GENERIC_COMMAND_RE = /^(ok|yes|no|yep|nope|sure|thanks|thank you|thx|got it|sounds good|go ahead|do it|implement this|implement that|do the implementation|proceed|continue|merge it|lgtm|approved|ship it|looks good|perfect|great|nice|cool|fine|alright|roger|understood|acknowledged|done|next|go|maybe|agreed|correct|right|exactly|absolutely|definitely|certainly|good|noted|copy|check|wow|ah|oh|hmm|hm|interesting|i see|makes sense|fair enough|good point|true|yea|yeah|yup|kk|k|okay)$/i;

/** Leading preamble patterns to strip before slicing content for injection */
const PREAMBLE_RE = /^(sure[,!]?\s*|certainly[,!]?\s*|of course[,!]?\s*|absolutely[,!]?\s*|great[!.]\s*|let me\s+|i'll\s+|i will\s+|good question[.!]?\s*|great question[.!]?\s*)/i;

/**
 * Extract a content snippet from a raw assistant message for context injection.
 * Strips leading filler preamble, slices at word boundary, appends ellipsis if truncated.
 * Pure function — O(n) where n = content length.
 */
export function extractContentSnippet(content: string, maxChars = 200): string {
  let s = content.trim();
  for (let pass = 0; pass < 3; pass++) {
    const stripped = s.replace(PREAMBLE_RE, "").trim();
    if (stripped === s) break;
    s = stripped;
  }
  if (!s) return "";
  if (s.length <= maxChars) return s;
  const boundary = s.lastIndexOf(" ", maxChars);
  return (boundary > 0 ? s.slice(0, boundary) : s.slice(0, maxChars)) + "…";
}

/**
 * Detect the appropriate category for a fact stored via [REMEMBER:] tag.
 * Exported so callers can share the same classification logic.
 */
export function detectMemoryCategory(content: string): string {
  const lower = content.toLowerCase();
  if (/\b(prefer|like|hate|always|never|style|format|concise|brief|formal|casual)\b/.test(lower)) {
    return "preference";
  }
  if (/\b(\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}|monday|tuesday|wednesday|thursday|friday|saturday|sunday|every\s+\w+day|\d{1,2}\/\d{1,2}|\d{4}-\d{2}-\d{2}|deadline\s+on)\b/.test(lower)) {
    return "date";
  }
  if (/\b(goal|want to|need to|plan to|by |deadline|launch|complete|finish)\b/.test(lower)) {
    return "goal";
  }
  return "personal";
}

/**
 * Parse Claude's response for memory intent tags.
 * Each tag is checked for semantic duplicates (via checkSemanticDuplicate)
 * before inserting — duplicates are silently skipped and logged.
 * Returns the cleaned response with all tags stripped.
 * When chatId is provided, all stored memory is tagged with that chat
 * so it stays isolated to the originating group.
 *
 * Supported tags:
 *   [REMEMBER: fact]          — stores memory scoped to this chat (or globally if no chatId)
 *   [REMEMBER_GLOBAL: fact]   — stores memory with chat_id = null, visible to all groups
 *   [GOAL: text]              — stores a goal for this chat
 *   [GOAL: text | DEADLINE: date] — stores a goal with deadline
 *   [DONE: search text]       — marks a matching goal as completed
 */

/**
 * Synchronously strips all memory intent tags from a response string.
 * Use this to get clean display text before firing processMemoryIntents in the background.
 */
export function stripMemoryTags(text: string): string {
  return text
    .replace(/\[REMEMBER:\s*.+?\]/gi, "")
    .replace(/\[REMEMBER_GLOBAL:\s*.+?\]/gi, "")
    .replace(/\[GOAL:\s*.+?\]/gi, "")
    .replace(/\[DONE:\s*.+?\]/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Guards against regex cross-tag span artifacts.
 *
 * The greedy/lazy regexes for [REMEMBER:] etc. can match across tag boundaries when
 * the LLM writes tag syntax in explanations (e.g. "`[GOAL:]`, `[DONE: x]`"). The
 * captured content then starts with `]` or contains another tag keyword — both are
 * invalid for real memory content. Reject those before storage.
 */
function isValidTagContent(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.startsWith("]")) return false;
  if (/\[(REMEMBER|REMEMBER_GLOBAL|GOAL|DONE|NEXT):/i.test(trimmed)) return false;
  if (trimmed.length < 3) return false;
  return true;
}

export async function processMemoryIntents(
  response: string,
  chatId?: number,
  threadId?: number | null
): Promise<string> {
  let clean = response;
  let memoryInsertCount = 0;

  // Pre-fetch existing facts once for text dedup (avoids N+1 queries inside loops).
  const factsList = await getExistingMemories("fact", { limit: 200 });

  // Shared handler for [REMEMBER:] and [REMEMBER_GLOBAL:] tags
  const processRememberTag = async (
    match: RegExpExecArray,
    tag: string,
    semanticChatId: number | null,
  ) => {
    if (isTextDuplicate(match[1], factsList)) {
      console.log(`[memory] Skipping duplicate [${tag}] (text match): "${match[1]}"`);
      clean = clean.replace(match[0], "");
      return;
    }

    const dupCheck = await checkSemanticDuplicate(match[1], "fact", semanticChatId);
    if (dupCheck.isDuplicate) {
      console.log(`[memory] Skipping duplicate ${tag === "REMEMBER_GLOBAL:" ? "global " : ""}fact: "${match[1]}" (similar: "${dupCheck.match?.content}")`);
      clean = clean.replace(match[0], "");
      return;
    }

    const category = detectMemoryCategory(match[1]);
    const scores = getMemoryScores("fact", category);
    await insertMemoryRecord({
      type: "fact",
      content: match[1],
      chat_id: chatId ?? null,
      thread_id: threadId ?? null,
      category,
      ...scores,
    });
    memoryInsertCount++;
    clean = clean.replace(match[0], "");
  };

  // [REMEMBER: fact to store]
  for (const match of response.matchAll(/\[REMEMBER:\s*(.+)\]/gi)) {
    if (!isValidTagContent(match[1])) continue;
    await processRememberTag(match as RegExpExecArray, "REMEMBER:", chatId ?? null);
  }

  // [REMEMBER_GLOBAL: fact to share across all groups]
  for (const match of response.matchAll(/\[REMEMBER_GLOBAL:\s*(.+)\]/gi)) {
    if (!isValidTagContent(match[1])) continue;
    await processRememberTag(match as RegExpExecArray, "REMEMBER_GLOBAL:", null);
  }

  // [GOAL: text] or [GOAL: text | DEADLINE: date]
  for (const match of response.matchAll(
    /\[GOAL:\s*(.+?)(?:\s*\|\s*DEADLINE:\s*(.+))?\]/gi
  )) {
    if (!isValidTagContent(match[1])) continue;
    // Text pre-check: query existing goals and run synchronous duplicate detection.
    const existingGoals = await getExistingMemories("goal", { limit: 100 });
    if (isTextDuplicateGoal(match[1], existingGoals)) {
      console.log(`[memory] Skipping duplicate [GOAL:] (text match): "${match[1]}"`);
      clean = clean.replace(match[0], "");
      continue;
    }

    const dupCheck = await checkSemanticDuplicate(match[1], "goal", chatId ?? null);
    if (dupCheck.isDuplicate) {
      console.log(`[memory] Skipping duplicate goal: "${match[1]}" (similar: "${dupCheck.match?.content}")`);
      clean = clean.replace(match[0], "");
      continue;
    }
    await insertMemoryRecord({
      type: "goal",
      content: match[1],
      deadline: match[2] || null,
      chat_id: chatId ?? null,
      thread_id: threadId ?? null,
      category: "goal",
      ...getMemoryScores("goal"),
    });
    memoryInsertCount++;
    clean = clean.replace(match[0], "");
  }

  // [DONE: search text for completed goal]
  for (const match of response.matchAll(/\[DONE:\s*(.+)\]/gi)) {
    if (!isValidTagContent(match[1])) continue;
    const goal = await findGoalByContent(match[1]);
    if (goal) {
      await updateMemoryRecord(goal.id, {
        type: "completed_goal",
        completed_at: new Date().toISOString(),
      });
    }
    clean = clean.replace(match[0], "");
  }

  // After successful memory inserts, check if profile summary needs rebuilding.
  if (memoryInsertCount > 0) {
    const totalSinceRebuild = incrementProfileRebuildCounter();
    if (totalSinceRebuild >= 5) {
      console.log(`[memory] ${totalSinceRebuild} inserts since last rebuild — triggering rebuildProfileSummary`);
      resetProfileRebuildCounter();
      const userId = parseInt(process.env.TELEGRAM_USER_ID || "0");
      rebuildProfileSummary(userId).catch((err) =>
        console.error("[memory] rebuildProfileSummary failed:", err)
      );
    }
  }

  return clean.trim();
}

/**
 * Returns facts and active goals filtered by chat_id when provided.
 * When chatId is given, returns items scoped to that chat OR global items (chat_id IS NULL).
 * When chatId is not provided, returns all items.
 */
export async function getMemoryContext(
  chatId?: number
): Promise<string> {
  try {
    const MAX_FACTS_IN_CONTEXT = 25;

    const [factsData, goalsData] = await Promise.all([
      getMemoryFacts({ limit: MAX_FACTS_IN_CONTEXT, chatId }),
      getMemoryGoals({ limit: 20, chatId }),
    ]);

    const parts: string[] = [];

    const cleanFacts = factsData.filter((f) => !isJunkMemoryContent(f.content));

    // Touch only high-importance facts for access tracking
    const highImportanceIds = cleanFacts
      .filter((f) => (f.importance ?? 0) >= 0.80)
      .map((f) => f.id)
      .filter(Boolean);

    if (highImportanceIds.length) {
      touchMemoryAccess(highImportanceIds);
    }

    if (cleanFacts.length) {
      const lines = cleanFacts
        .map((f) => `  • ${f.content.trim()}`)
        .join("\n");
      parts.push(`📌 FACTS\n${"─".repeat(24)}\n${lines}`);
    }

    const cleanGoals = goalsData.filter((g) => !isJunkMemoryContent(g.content));
    if (cleanGoals.length) {
      const lines = cleanGoals
        .map((g: any) => {
          const deadline = g.deadline
            ? ` (by ${new Date(g.deadline).toLocaleDateString()})`
            : "";
          return `  • ${g.content.trim()}${deadline}`;
        })
        .join("\n");
      parts.push(`🎯 GOALS\n${"─".repeat(24)}\n${lines}`);
    }

    return parts.join("\n\n");
  } catch (error) {
    console.error("Memory context error:", error);
    return "";
  }
}

export interface MemoryItem {
  content: string;
  deadline?: string | null;
}

export interface RawMemory {
  facts: MemoryItem[];
  goals: MemoryItem[];
}

/**
 * Returns facts and active goals as structured arrays, applying the same
 * junk filter as getMemoryContext(). Useful when the caller needs to
 * iterate over individual items (e.g. for per-item summarization).
 * When chatId is given, returns items scoped to that chat OR global items.
 */
export async function getMemoryContextRaw(
  chatId?: number
): Promise<RawMemory> {
  const empty: RawMemory = { facts: [], goals: [] };

  try {
    // Use storageBackend (local-first) for reads
    const [factsData, goalsData] = await Promise.all([
      getMemoryFacts({ limit: 50, chatId }),
      getMemoryGoals({ limit: 20, chatId }),
    ]);

    const facts: MemoryItem[] = factsData
      .filter((f) => !isJunkMemoryContent(f.content))
      .map((f) => ({ content: f.content.trim() }));

    const goals: MemoryItem[] = goalsData
      .filter((g: any) => !isJunkMemoryContent(g.content))
      .map((g: any) => ({
        content: g.content.trim(),
        deadline: g.deadline ?? null,
      }));

    return { facts, goals };
  } catch (error) {
    console.error("Memory context raw error:", error);
    return empty;
  }
}

export interface MemoryItemFull {
  content: string;
  deadline?: string | null;
  category?: string | null;
  completed_at?: string | null;
  chat_id?: number | null;
  thread_id?: number | null;
}

export interface FullMemory {
  goals: MemoryItemFull[];
  completedGoals: MemoryItemFull[];
  facts: MemoryItemFull[];       // type=fact AND category != 'date'
  dates: MemoryItemFull[];       // type=fact AND category = 'date'
}

/**
 * Fetches all memory types in a single parallel query pair.
 * Used by /memory command for instant, Claude-free display.
 * When chatId is given, returns items scoped to that chat OR global (chat_id IS NULL).
 */
export async function getMemoryFull(
  chatId?: number
): Promise<FullMemory> {
  const empty: FullMemory = { goals: [], completedGoals: [], facts: [], dates: [] };

  try {
    const local = await getAllMemoryForDisplay(chatId);
    const clean = (rows: any[]): MemoryItemFull[] =>
      (rows ?? [])
        .filter((r: any) => !isJunkMemoryContent(r.content))
        .map((r: any) => ({
          content: (r.content ?? "").trim(),
          deadline: r.deadline ?? null,
          category: r.category ?? null,
          completed_at: r.completed_at ?? null,
          chat_id: r.chat_id ? Number(r.chat_id) : null,
          thread_id: r.thread_id ? Number(r.thread_id) : null,
        }));
    return {
      goals: clean(local.goals),
      completedGoals: clean(local.completedGoals),
      facts: clean(local.facts),
      dates: clean(local.dates),
    };
  } catch (error) {
    console.error("getMemoryFull error:", error);
    return empty;
  }
}

/**
 * Searches past messages and memory items via semantic search.
 * Queries both `messages` and `memory` collections in parallel, merging results.
 * Memory matches are appended as a separate "Related memories" section.
 * When chatId is provided, passes it to the search for filtering.
 */
// FIX 6: In-memory cache for semantic search results (60s TTL)
// Prevents redundant embedding calls for identical/similar queries.
const searchCache = new Map<string, { result: string; expiry: number }>();

// Periodic eviction: sweep expired entries every 2 minutes.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of searchCache) {
    if (now >= entry.expiry) searchCache.delete(key);
  }
}, 120_000).unref();

export async function getRelevantContext(
  query: string,
  chatId?: number,
  crossGroup?: boolean,
  excludeIds?: Set<string>
): Promise<string> {
  const cacheKey = `${chatId ?? "global"}:${Bun.hash(query).toString(36)}${excludeIds?.size ? `:ex${excludeIds.size}` : ""}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() < cached.expiry) return cached.result;

  try {
    const [messageHitsRaw, memoryHits] = await Promise.all([
      semanticSearchMessages(query, {
        matchCount: 3,
        chatId: chatId?.toString(),
        role: "assistant",
        threshold: 0.6,
      }),
      semanticSearchMemory(query, {
        matchCount: 3,
        threshold: 0.7,
        chatId: chatId?.toString(),
      }),
    ]);

    const messageHits = excludeIds?.size
      ? messageHitsRaw.filter((m) => !excludeIds.has(m.id))
      : messageHitsRaw;

    const parts: string[] = [];

    if (messageHits.length) {
      const topicLines: string[] = [];
      for (let i = 0; i < messageHits.length; i++) {
        const m = messageHits[i];
        // Fetch metadata for label (date, source) and preceding user message for Q: prefix
        const row = getDb()
          .query("SELECT created_at, agent_id, thread_name, chat_id, thread_id FROM messages WHERE id = ?")
          .get(m.id) as { created_at: string; agent_id: string | null; thread_name: string | null; chat_id: string | null; thread_id: string | null } | null;
        const date = row?.created_at?.split(" ")[0] ?? "";
        const source = row?.thread_name ?? row?.agent_id ?? resolveSourceLabel(row?.chat_id ? Number(row.chat_id) : null, row?.thread_id ? Number(row.thread_id) : null);

        // Fetch preceding user message (the question that prompted this assistant response)
        const precRow = row?.created_at && row?.chat_id
          ? getDb()
              .query(
                "SELECT content, topic FROM messages WHERE chat_id = ? AND created_at < ? AND role = 'user' ORDER BY created_at DESC LIMIT 1"
              )
              .get(row.chat_id, row.created_at) as { content: string; topic: string | null } | null
          : null;

        let userTopic: string | null = null;
        if (precRow) {
          userTopic = precRow.topic ?? precRow.content.slice(0, 80).trim();
        }

        // Quality gate: skip Q: prefix if user message is a generic command with no domain signal
        const isGenericCommand = precRow?.content
          ? GENERIC_COMMAND_RE.test(precRow.content.trim())
          : false;
        const labelLine = userTopic && !isGenericCommand
          ? `[R${i + 1}] Q: "${userTopic}" — ${date}, ${source}`
          : `[R${i + 1}] — ${date}, ${source}`;
        const snippet = extractContentSnippet(m.content);
        topicLines.push(snippet ? `${labelLine}\n↳ "${snippet}"` : labelLine);
      }
      // Cap the hits block at 1,200 chars — trim at last newline boundary to drop partial entries
      const joined = topicLines.join("\n");
      const hitsBlock = joined.length > 1200
        ? (joined.lastIndexOf("\n", 1197) > 0 ? joined.slice(0, joined.lastIndexOf("\n", 1197)) : joined.slice(0, 1200))
        : joined;
      parts.push(`📚 Past Context:\n${hitsBlock}`);
    }

    if (memoryHits.length) {
      const memoryLines = memoryHits
        .map((m) => `• ${m.content}`)
        .join("\n");
      parts.push(`\n\n📌 Related memories:\n${memoryLines}`);

      const ids = memoryHits.map((m) => m.id).filter(Boolean);
      if (ids.length) {
        touchMemoryAccess(ids);
      }
    }

    const result = parts.join("");
    searchCache.set(cacheKey, { result, expiry: Date.now() + 60_000 });
    return result;
  } catch {
    return "";
  }
}
