/**
 * Claude Telegram Relay — Group Discovery & Test Utility
 *
 * Listens for Telegram messages and logs chat IDs so users can
 * configure their multi-agent groups. Also verifies group routing
 * configuration if .env group chat IDs are already set.
 *
 * Usage: bun run setup/test-groups.ts
 */

import { Bot } from "grammy";
import { join, dirname } from "path";

const PROJECT_ROOT = dirname(import.meta.dir);

// Colors
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

const PASS = green("✓");
const FAIL = red("✗");
const WARN = yellow("!");
const INFO = cyan("i");

// Expected group names from the implementation plan
const EXPECTED_GROUPS: Record<string, { envKey: string; agentId: string }> = {
  "AWS Cloud Architect": { envKey: "GROUP_AWS_CHAT_ID", agentId: "aws-architect" },
  "Security & Compliance": { envKey: "GROUP_SECURITY_CHAT_ID", agentId: "security-analyst" },
  "Technical Documentation": { envKey: "GROUP_DOCS_CHAT_ID", agentId: "documentation-specialist" },
  "Code Quality & TDD": { envKey: "GROUP_CODE_CHAT_ID", agentId: "code-quality-coach" },
  "General AI Assistant": { envKey: "GROUP_GENERAL_CHAT_ID", agentId: "general-assistant" },
};

// Load .env manually (no dotenv dependency)
async function loadEnv(): Promise<Record<string, string>> {
  const envPath = join(PROJECT_ROOT, ".env");
  try {
    const content = await Bun.file(envPath).text();
    const vars: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return vars;
  } catch {
    return {};
  }
}

// Track discovered groups during the listening session
const discoveredGroups = new Map<number, string>();

/**
 * Calculate Levenshtein distance between two strings
 * (measures how many single-character edits are needed to change one string to another)
 */
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Fuzzy match group title to expected names (handles typos and case differences)
 */
function fuzzyMatchGroup(chatTitle: string): [string, { envKey: string; agentId: string }] | null {
  const titleLower = chatTitle.toLowerCase().trim();

  // Try exact match first (case-insensitive)
  for (const [name, config] of Object.entries(EXPECTED_GROUPS)) {
    if (titleLower === name.toLowerCase()) {
      return [name, config];
    }
  }

  // Try substring match
  for (const [name, config] of Object.entries(EXPECTED_GROUPS)) {
    if (titleLower.includes(name.toLowerCase()) || name.toLowerCase().includes(titleLower)) {
      return [name, config];
    }
  }

  // Try fuzzy match (allow up to 2 character differences for typos)
  let bestMatch: [string, { envKey: string; agentId: string }] | null = null;
  let bestDistance = Infinity;

  for (const [name, config] of Object.entries(EXPECTED_GROUPS)) {
    const distance = levenshteinDistance(titleLower, name.toLowerCase());
    const tolerance = Math.max(2, Math.floor(name.length * 0.15)); // Allow 15% difference or 2 chars

    if (distance <= tolerance && distance < bestDistance) {
      bestDistance = distance;
      bestMatch = [name, config];
    }
  }

  return bestMatch;
}

async function main() {
  console.log("");
  console.log(bold("  Multi-Agent Group Discovery & Test"));
  console.log("");

  const env = await loadEnv();
  const token = env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "";

  // Check token
  if (!token || token === "your_bot_token_from_botfather") {
    console.log(`  ${FAIL} TELEGRAM_BOT_TOKEN not set in .env`);
    console.log(`      ${dim("Run 'bun run setup' first to configure your bot")}`);
    process.exit(1);
  }
  console.log(`  ${PASS} Bot token found`);

  // Check which group chat IDs are already configured
  console.log(`\n  ${bold("Configured Groups:")}`);
  let configuredCount = 0;

  for (const [groupName, { envKey }] of Object.entries(EXPECTED_GROUPS)) {
    const chatId = env[envKey] || process.env[envKey] || "";
    if (chatId) {
      console.log(`  ${PASS} ${groupName}: ${chatId}`);
      configuredCount++;
    } else {
      console.log(`  ${dim(`  - ${groupName}: not configured (${envKey})`)}`);
    }
  }

  if (configuredCount === 5) {
    console.log(`\n  ${green("All 5 groups configured!")}`);
    await verifyConfiguredGroups(token, env);
    return;
  }

  if (configuredCount > 0) {
    console.log(`\n  ${WARN} ${configuredCount}/5 groups configured`);
  }

  // Start listening mode
  console.log(`\n  ${bold("Listening for messages...")}`);
  console.log(`\n  ${yellow("IMPORTANT:")} The bot must be added to each group as a member.`);
  console.log(`  ${yellow("IMPORTANT:")} Privacy Mode must be ${bold("OFF")} for the bot to see messages.`);
  console.log(`\n  ${bold("To disable Privacy Mode:")}`);
  console.log(`    1. Message @BotFather on Telegram`);
  console.log(`    2. Send /mybots and select your bot`);
  console.log(`    3. Go to ${bold("Bot Settings")} → ${bold("Group Privacy")}`);
  console.log(`    4. Turn ${bold("OFF")} Privacy Mode`);
  console.log(`\n  ${bold("Quick test:")} Send a command like ${cyan("/test")} in each group.`);
  console.log(`  ${dim("(Commands work even with Privacy Mode ON)")}`);
  console.log(`\n  The bot expects groups named:`);
  for (const groupName of Object.keys(EXPECTED_GROUPS)) {
    console.log(`    - "${groupName}"`);
  }
  console.log(`\n  ${dim("Press Ctrl+C to stop.\n")}`);

  const bot = new Bot(token);

  // Reminder timer if no messages received
  let messageReceived = false;
  const reminderTimer = setTimeout(() => {
    if (!messageReceived) {
      console.log(`\n  ${yellow("⏰ No messages received yet.")}`);
      console.log(`     Did you ${bold("disable Privacy Mode")} in BotFather?`);
      console.log(`     Try sending ${cyan("/test")} in a group to verify bot access.\n`);
    }
  }, 30000); // 30 seconds

  bot.on("message", async (ctx) => {
    messageReceived = true;
    const chatId = ctx.chat?.id;
    const chatType = ctx.chat?.type;
    const chatTitle = (ctx.chat as any)?.title || "";
    const text = ctx.message?.text || "(non-text message)";
    const from = ctx.from?.first_name || "Unknown";

    if (!chatId) return;

    // Log every message with context
    const timestamp = new Date().toLocaleTimeString();
    console.log(`  ${cyan("[")}${timestamp}${cyan("]")} ${bold(chatTitle || "DM")} ${dim(`(${chatType}, ID: ${chatId})`)}`);
    console.log(`      From: ${from} | Message: ${text.substring(0, 60)}${text.length > 60 ? "..." : ""}`);

    // Track group chats
    if (chatType === "group" || chatType === "supergroup") {
      if (!discoveredGroups.has(chatId)) {
        discoveredGroups.set(chatId, chatTitle);

        // Check if this matches an expected group name (with fuzzy matching for typos)
        const matchedGroup = fuzzyMatchGroup(chatTitle);

        if (matchedGroup) {
          const [groupName, { envKey }] = matchedGroup;

          // Show different message if name differs (fuzzy match vs exact)
          if (chatTitle !== groupName) {
            console.log(`\n  ${PASS} ${green("Matched!")} "${chatTitle}" -> ${groupName} ${yellow("(typo detected)")}`);
            console.log(`      ${dim(`Tip: Rename group to "${groupName}" for exact match`)}`);
          } else {
            console.log(`\n  ${PASS} ${green("Matched!")} "${chatTitle}" -> ${groupName}`);
          }
          console.log(`      Add to .env: ${bold(`${envKey}=${chatId}`)}`);
        } else {
          console.log(`\n  ${WARN} Group "${chatTitle}" does not match any expected agent group`);
          console.log(`      Expected names: ${Object.keys(EXPECTED_GROUPS).join(", ")}`);
        }

        // Show progress
        const remaining = 5 - discoveredGroups.size;
        if (remaining > 0) {
          console.log(`\n      ${dim(`${discoveredGroups.size}/5 groups discovered. ${remaining} remaining.`)}`);
        } else {
          console.log(`\n  ${green("All groups discovered!")} Here is your .env config:\n`);
          printEnvConfig();
        }
        console.log("");
      }
    } else if (chatType === "private") {
      console.log(`      ${dim("(Direct message - not a group)")}`);
    }
  });

  // Handle graceful shutdown
  const shutdown = () => {
    clearTimeout(reminderTimer);
    console.log(`\n\n  ${bold("Summary:")}`);
    if (discoveredGroups.size > 0) {
      printEnvConfig();
    } else {
      console.log(`  ${WARN} No groups discovered.`);
      console.log(`\n  ${bold("Troubleshooting:")}`);
      console.log(`    1. Make sure the bot is added to each group`);
      console.log(`    2. Check if Privacy Mode is ${bold("OFF")} (see instructions above)`);
      console.log(`    3. Try sending a command like ${cyan("/test")} in each group`);
      console.log(`    4. Make sure messages were sent ${bold("after")} starting this script`);
    }
    console.log("");
    bot.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await bot.start({ drop_pending_updates: true });
}

/**
 * Verify already-configured groups by checking the bot can reach them.
 */
async function verifyConfiguredGroups(
  token: string,
  env: Record<string, string>
): Promise<void> {
  console.log(`\n  ${bold("Verifying group access...")}`);

  let allOk = true;

  for (const [groupName, { envKey }] of Object.entries(EXPECTED_GROUPS)) {
    const chatId = env[envKey] || process.env[envKey] || "";
    if (!chatId) continue;

    try {
      const res = await fetch(
        `https://api.telegram.org/bot${token}/getChat`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId }),
        }
      );
      const data = (await res.json()) as any;

      if (data.ok) {
        const title = data.result.title || "DM";
        const type = data.result.type;

        if (title === groupName || title.includes(groupName)) {
          console.log(`  ${PASS} ${groupName}: "${title}" (${type})`);
        } else {
          console.log(`  ${WARN} ${groupName}: chat found as "${title}" - name mismatch`);
          console.log(`      ${dim(`Expected "${groupName}", got "${title}"`)}`);
        }
      } else {
        console.log(`  ${FAIL} ${groupName}: ${data.description}`);
        allOk = false;
      }
    } catch (err: any) {
      console.log(`  ${FAIL} ${groupName}: ${err.message}`);
      allOk = false;
    }
  }

  if (allOk) {
    console.log(`\n  ${green("All configured groups verified!")}`);
  } else {
    console.log(`\n  ${WARN} Some groups could not be verified.`);
    console.log(`      ${dim("Make sure the bot is added to each group.")}`);
  }
  console.log("");
}

/**
 * Print discovered groups as .env configuration lines.
 */
function printEnvConfig(): void {
  console.log(`  ${dim("# Add these to your .env file:")}`);

  for (const [groupName, { envKey }] of Object.entries(EXPECTED_GROUPS)) {
    // Try fuzzy matching for each discovered group
    const match = Array.from(discoveredGroups.entries()).find(
      ([, title]) => {
        const fuzzyMatch = fuzzyMatchGroup(title);
        return fuzzyMatch && fuzzyMatch[0] === groupName;
      }
    );

    if (match) {
      const [chatId, title] = match;
      if (title !== groupName) {
        console.log(`  ${envKey}=${chatId}  ${dim(`# Group: "${title}" (close match)`)}`);
      } else {
        console.log(`  ${envKey}=${chatId}`);
      }
    } else {
      console.log(`  ${dim(`# ${envKey}=  (not discovered - "${groupName}")`)}`);
    }
  }
}

main().catch((err) => {
  console.error(`\n  ${red("Error:")} ${err.message}`);
  process.exit(1);
});
