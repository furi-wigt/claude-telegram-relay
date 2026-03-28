/**
 * Claude Telegram Relay — Group Discovery & Auto-Config
 *
 * Listens for Telegram messages, matches group titles against agents.json
 * `groupName` fields, and writes discovered chatIds back to
 * ~/.claude-relay/agents.json automatically.
 *
 * Usage:
 *   bun run test:groups            # discover + write chatIds
 *   bun run test:groups --verify   # verify already-configured groups
 */

import { Bot } from "grammy";
import { join, dirname } from "path";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";

// ─── Paths ────────────────────────────────────────────────────────────────────

const PROJECT_ROOT = dirname(import.meta.dir);
const USER_AGENTS_PATH = join(homedir(), ".claude-relay", "agents.json");

function resolveAgentsReadPath(): string {
  if (existsSync(USER_AGENTS_PATH)) return USER_AGENTS_PATH;
  const repo = join(PROJECT_ROOT, "config", "agents.json");
  if (existsSync(repo)) return repo;
  return join(PROJECT_ROOT, "config", "agents.example.json");
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface AgentEntry {
  id: string;
  name: string;
  groupName: string;
  chatId: number | null;
  [key: string]: unknown; // preserve all other fields on write-back
}

// ─── Colours ─────────────────────────────────────────────────────────────────

const green  = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red    = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan   = (s: string) => `\x1b[36m${s}\x1b[0m`;
const dim    = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold   = (s: string) => `\x1b[1m${s}\x1b[0m`;

const PASS = green("✓");
const FAIL = red("✗");
const WARN = yellow("!");

// ─── Agent loading ────────────────────────────────────────────────────────────

function loadAgents(): AgentEntry[] {
  const path = resolveAgentsReadPath();
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as AgentEntry[];
  } catch (err: any) {
    console.error(`\n  ${red("Error:")} Failed to parse agents.json at ${path}`);
    console.error(`         ${err.message}`);
    process.exit(1);
  }
}

// ─── Fuzzy matching ───────────────────────────────────────────────────────────

/** O(m*n) space-optimised Levenshtein using a single rolling row. */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

/**
 * Match a Telegram group title to an agent.
 * Priority: exact (case-insensitive) → substring → levenshtein fuzzy.
 * Complexity: O(n) exact/substring, O(n * max_len) fuzzy — n ≤ 6 agents.
 */
function matchAgent(title: string, agents: AgentEntry[]): AgentEntry | null {
  const t = title.toLowerCase().trim();

  for (const a of agents) {
    if (t === a.groupName.toLowerCase()) return a;
  }
  for (const a of agents) {
    const g = a.groupName.toLowerCase();
    if (t.includes(g) || g.includes(t)) return a;
  }

  let best: AgentEntry | null = null;
  let bestDist = Infinity;
  for (const a of agents) {
    const g = a.groupName.toLowerCase();
    const tolerance = Math.max(2, Math.floor(g.length * 0.15));
    const dist = levenshtein(t, g);
    if (dist <= tolerance && dist < bestDist) {
      bestDist = dist;
      best = a;
    }
  }
  return best;
}

// ─── agents.json write-back ───────────────────────────────────────────────────

/**
 * Atomic read-modify-write to ~/.claude-relay/agents.json.
 * Always writes to USER_AGENTS_PATH — promotes fallback copy if needed.
 */
async function writeChatId(agentId: string, chatId: number): Promise<void> {
  let agents: AgentEntry[];
  try {
    const raw = await Bun.file(USER_AGENTS_PATH).text();
    agents = JSON.parse(raw);
  } catch {
    // user path doesn't exist yet — promote fallback into user path
    agents = loadAgents();
  }

  const idx = agents.findIndex((a) => a.id === agentId);
  if (idx !== -1) agents[idx].chatId = chatId;

  try {
    await Bun.write(USER_AGENTS_PATH, JSON.stringify(agents, null, 2) + "\n");
  } catch (err: any) {
    console.error(`  ${WARN} Failed to write agents.json: ${err.message}`);
  }
}

// ─── .env / token loading ─────────────────────────────────────────────────────

async function loadToken(): Promise<string> {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN;

  const envPaths = [
    join(PROJECT_ROOT, ".env"),
    join(homedir(), ".claude-relay", ".env"),
  ];
  for (const envPath of envPaths) {
    try {
      const content = await Bun.file(envPath).text();
      for (const line of content.split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const eq = t.indexOf("=");
        if (eq === -1) continue;
        if (t.slice(0, eq).trim() === "TELEGRAM_BOT_TOKEN") {
          return t.slice(eq + 1).trim();
        }
      }
    } catch {
      // file not found — try next
    }
  }
  return "";
}

// ─── Verify mode ─────────────────────────────────────────────────────────────

async function verifyGroups(token: string, agents: AgentEntry[]): Promise<void> {
  console.log(`\n  ${bold("Verifying group access via Telegram API...")}\n`);

  let allOk = true;
  for (const agent of agents) {
    if (agent.chatId == null) {
      console.log(`  ${WARN} ${agent.groupName}: ${dim("chatId not set")}`);
      allOk = false;
      continue;
    }
    try {
      const res = await fetch("https://api.telegram.org/bot" + token + "/getChat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: agent.chatId }),
        signal: AbortSignal.timeout(8000),
      });
      const data = (await res.json()) as any;
      if (data.ok) {
        const title: string = data.result.title ?? "(no title)";
        const matched = title.toLowerCase().includes(agent.groupName.toLowerCase())
          || agent.groupName.toLowerCase().includes(title.toLowerCase());
        if (matched) {
          console.log(`  ${PASS} ${agent.groupName} ${dim(`(${agent.chatId})`)}: "${title}"`);
        } else {
          console.log(`  ${WARN} ${agent.groupName} ${dim(`(${agent.chatId})`)}: found "${title}" — name mismatch`);
          allOk = false;
        }
      } else {
        console.log(`  ${FAIL} ${agent.groupName}: ${data.description}`);
        allOk = false;
      }
    } catch (err: any) {
      console.log(`  ${FAIL} ${agent.groupName}: ${err.message}`);
      allOk = false;
    }
  }

  console.log(allOk
    ? `\n  ${green("All groups verified and reachable!")}`
    : `\n  ${WARN} Some groups could not be verified. Check bot membership in each group.`
  );
  console.log("");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const verifyOnly = args.includes("--verify");

  console.log("");
  console.log(bold("  Claude Telegram Relay — Group Discovery"));
  console.log("");

  const token = await loadToken();
  if (!token || token === "your_bot_token_from_botfather") {
    console.log(`  ${FAIL} TELEGRAM_BOT_TOKEN not set. Run ${cyan("bun run setup")} first.`);
    process.exit(1);
  }
  console.log(`  ${PASS} Bot token found`);

  const agents = loadAgents();
  const total    = agents.length;
  const resolved = agents.filter((a) => a.chatId != null);
  const pending  = agents.filter((a) => a.chatId == null);

  // ── Current state summary ─────────────────────────────────────────────────
  console.log(`\n  ${bold("Current state:")} ${resolved.length}/${total} groups configured\n`);
  for (const a of agents) {
    if (a.chatId != null) {
      console.log(`  ${PASS} ${a.groupName} ${dim(`→ ${a.chatId}`)}`);
    } else {
      console.log(`  ${dim(`  - ${a.groupName}: not configured`)}`);
    }
  }

  // ── All resolved or --verify flag → verify mode ───────────────────────────
  if (resolved.length === total || verifyOnly) {
    await verifyGroups(token, agents);
    return;
  }

  // ── Partial/none → listen mode ────────────────────────────────────────────
  console.log(`\n  ${bold("Listening for messages...")}`);
  console.log(`\n  Send any message in each unconfigured Telegram group.`);
  console.log(`  The bot must be a ${bold("group member")} with ${bold("Privacy Mode OFF")} in BotFather.\n`);
  console.log(`  Expected group names (unconfigured):`);
  for (const a of pending) {
    console.log(`    ${cyan("•")} "${a.groupName}"`);
  }
  console.log(`\n  ${dim("Press Ctrl+C to stop.\n")}`);

  // Track what we've matched this session (avoid duplicate writes)
  const sessionResolved = new Set<string>();

  const bot = new Bot(token);

  // 30s reminder if nothing heard
  let receivedAny = false;
  const reminder = setTimeout(() => {
    if (!receivedAny) {
      console.log(`\n  ${yellow("⏰ No messages received yet.")}`);
      console.log(`     • Is Privacy Mode OFF in BotFather?`);
      console.log(`     • Is the bot added to each group?`);
      console.log(`     • Try sending ${cyan("/test")} in a group (commands bypass Privacy Mode)\n`);
    }
  }, 30_000);

  bot.on("message", async (ctx) => {
    receivedAny = true;
    const chat = ctx.chat;
    if (chat.type !== "supergroup" && chat.type !== "group") return;

    const chatId    = chat.id;
    const chatTitle = (chat as any).title as string ?? "";
    const ts        = new Date().toLocaleTimeString();

    const agent = matchAgent(chatTitle, agents);

    if (!agent) {
      console.log(`  ${dim(`[${ts}]`)} ${WARN} "${chatTitle}" ${dim(`(${chatId})`)} — no agent match`);
      return;
    }

    // Already resolved (config or this session)
    if (agent.chatId != null || sessionResolved.has(agent.id)) {
      console.log(`  ${dim(`[${ts}]`)} ${dim(`"${chatTitle}" → already mapped to ${agent.id}, skipped`)}`);
      return;
    }

    // Success
    const fuzzy = chatTitle !== agent.groupName;
    const label = fuzzy
      ? `"${chatTitle}" ${yellow("≈")} "${agent.groupName}" ${yellow("(fuzzy)")}`
      : `"${chatTitle}"`;
    console.log(`  ${dim(`[${ts}]`)} ${PASS} ${green("Matched!")} ${label} ${dim("→")} ${cyan(agent.id)}`);
    if (fuzzy) {
      console.log(`         ${dim(`Tip: rename group to "${agent.groupName}" for exact match`)}`);
    }

    // Mutate in-memory + write-back
    agent.chatId = chatId;
    sessionResolved.add(agent.id);
    await writeChatId(agent.id, chatId);

    const doneCount  = resolved.length + sessionResolved.size;
    const remaining  = total - doneCount;

    if (remaining > 0) {
      console.log(`         ${dim(`${doneCount}/${total} done — ${remaining} remaining`)}\n`);
    } else {
      clearTimeout(reminder);
      console.log(`\n  ${green(bold("All groups discovered!"))} ~/.claude-relay/agents.json updated.\n`);
      console.log(`  Next step: ${cyan("npx pm2 restart telegram-relay")}\n`);
      await bot.stop();
      process.exit(0);
    }
  });

  const shutdown = () => {
    clearTimeout(reminder);
    const doneCount = resolved.length + sessionResolved.size;
    console.log(`\n\n  ${bold("Session summary:")} ${doneCount}/${total} groups configured.`);
    if (sessionResolved.size > 0) {
      console.log(`  ${PASS} ~/.claude-relay/agents.json updated.`);
    }
    if (doneCount < total) {
      console.log(`\n  ${WARN} Run ${cyan("bun run test:groups")} again to finish.\n`);
    }
    console.log("");
    bot.stop();
    process.exit(0);
  };

  process.on("SIGINT",  shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await bot.start({ drop_pending_updates: true });
  } catch (err: any) {
    clearTimeout(reminder);
    if (err.message?.includes("409")) {
      console.error(`\n  ${FAIL} ${bold("409 Conflict")} — another bot instance is running.`);
      console.error(`     Stop it first: ${cyan("npx pm2 stop telegram-relay")}`);
    } else {
      console.error(`\n  ${FAIL} Bot failed to start: ${err.message}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\n  ${red("Fatal:")} ${err.message}`);
  process.exit(1);
});
