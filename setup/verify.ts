/**
 * Claude Telegram Relay — Verify Setup
 *
 * Runs all health checks in sequence: env, Telegram, local storage,
 * services, and reports overall status.
 *
 * Usage: bun run setup/verify.ts
 */

import { existsSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

const PROJECT_ROOT = dirname(import.meta.dir);

// Colors
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

const PASS = green("✓");
const FAIL = red("✗");
const WARN = yellow("!");

let passed = 0;
let failed = 0;
let warned = 0;

function pass(msg: string) { console.log(`  ${PASS} ${msg}`); passed++; }
function fail(msg: string) { console.log(`  ${FAIL} ${msg}`); failed++; }
function warn(msg: string) { console.log(`  ${WARN} ${msg}`); warned++; }

// Load .env with two-pass layering — same order as src/relay.ts:
//   Pass 1: project .env  — defaults (do not override process.env)
//   Pass 2: ~/.claude-relay/.env — user secrets (always wins)
async function loadEnv(): Promise<Record<string, string>> {
  const vars: Record<string, string> = {};

  async function readEnvFile(filePath: string, override: boolean): Promise<void> {
    try {
      const content = await Bun.file(filePath).text();
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1).trim();
        if (override || !(key in vars)) vars[key] = value;
      }
    } catch {
      // file not found — continue
    }
  }

  await readEnvFile(join(PROJECT_ROOT, ".env"), false);
  await readEnvFile(join(homedir(), ".claude-relay", ".env"), true);
  return vars;
}

async function main() {
  console.log("");
  console.log(bold("  Claude Telegram Relay — Health Check"));
  console.log("");

  const env = await loadEnv();

  // 1. Files
  console.log(bold("  Files"));
  existsSync(join(PROJECT_ROOT, ".env")) ? pass(".env exists") : fail(".env missing — run: bun run setup");
  existsSync(join(PROJECT_ROOT, "node_modules")) ? pass("Dependencies installed") : fail("node_modules missing — run: bun install");
  existsSync(join(PROJECT_ROOT, "config", "profile.md")) ? pass("Profile configured") : warn("No profile.md — copy config/profile.example.md");

  // 2. Telegram
  console.log(`\n${bold("  Telegram")}`);
  const token = env.TELEGRAM_BOT_TOKEN || "";
  const userId = env.TELEGRAM_USER_ID || "";

  if (!token || token.includes("your_")) {
    fail("TELEGRAM_BOT_TOKEN not set");
  } else {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const data = await res.json() as any;
      data.ok ? pass(`Bot: @${data.result.username}`) : fail(`Invalid token: ${data.description}`);
    } catch (e: any) {
      fail(`Telegram API unreachable: ${e.message}`);
    }
  }

  if (!userId || userId.includes("your_")) {
    fail("TELEGRAM_USER_ID not set");
  } else {
    pass(`User ID: ${userId}`);
  }

  // 3. Local Storage (SQLite + Qdrant)
  console.log(`\n${bold("  Local Storage")}`);
  try {
    const { existsSync } = await import("fs");
    const { join } = await import("path");
    const dbPath = join(process.cwd(), "data", "local.db");
    existsSync(dbPath) ? pass(`SQLite DB: ${dbPath}`) : warn("SQLite DB not yet created (will be auto-created on first run)");
  } catch (e: any) {
    warn(`Could not check local DB: ${e.message}`);
  }

  // 4. Services (macOS only)
  if (process.platform === "darwin") {
    console.log(`\n${bold("  Services (launchd)")}`);
    for (const label of ["com.claude.telegram-relay", "com.claude.smart-checkin", "com.claude.morning-briefing"]) {
      const proc = Bun.spawn(["launchctl", "list", label], { stdout: "pipe", stderr: "pipe" });
      const code = await proc.exited;
      code === 0 ? pass(`${label} loaded`) : warn(`${label} not loaded`);
    }
  }

  // 5. Optional
  console.log(`\n${bold("  Optional")}`);
  env.GEMINI_API_KEY && !env.GEMINI_API_KEY.includes("your_")
    ? pass("Voice transcription (Gemini) configured")
    : warn("No GEMINI_API_KEY — voice messages won't be transcribed");

  env.USER_NAME && !env.USER_NAME.includes("Your ")
    ? pass(`Name: ${env.USER_NAME}`)
    : warn("USER_NAME not set in .env");

  env.USER_TIMEZONE && env.USER_TIMEZONE !== "UTC"
    ? pass(`Timezone: ${env.USER_TIMEZONE}`)
    : warn("USER_TIMEZONE is UTC — update to your local timezone");

  // Summary
  console.log(`\n${bold("  Summary")}`);
  console.log(`  ${green(`${passed} passed`)}  ${failed > 0 ? red(`${failed} failed`) : ""}  ${warned > 0 ? yellow(`${warned} warnings`) : ""}`);

  if (failed === 0) {
    console.log(`\n  ${green("Your bot is ready!")} Run: bun run start`);
  } else {
    console.log(`\n  ${red("Fix the failures above, then re-run:")} bun run setup:verify`);
  }
  console.log("");

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n  ${red("Error:")} ${err.message}`);
  process.exit(1);
});
