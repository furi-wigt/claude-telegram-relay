#!/usr/bin/env bun

/**
 * @routine smart-checkin
 * @description Smart proactive check-in that evaluates context and reaches out if needed
 * @target Personal chat
 */
// @schedule */30 * * * *

/**
 * Smart Check-in Routine
 *
 * Schedule: Every 2 hours during waking hours (8 AM - 10 PM SGT)
 * Target: General AI Assistant group
 *
 * Uses Claude CLI to decide whether to check in with the user.
 * Only sends a message if there is a genuine reason (goal deadline,
 * long silence, pending follow-up). Stays silent otherwise.
 *
 * Run manually: bun run routines/smart-checkin.ts
 */

import { spawn } from "bun";
import { readFile, writeFile } from "fs/promises";
import { createClient } from "@supabase/supabase-js";
import { sendAndRecord } from "../src/utils/routineMessage.ts";
import { GROUPS, validateGroup } from "../src/config/groups.ts";
import { USER_NAME, USER_TIMEZONE } from "../src/config/userConfig.ts";

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const STATE_FILE = process.env.CHECKIN_STATE_FILE || "/tmp/group-checkin-state.json";

// ============================================================
// STATE MANAGEMENT
// ============================================================

interface CheckinState {
  lastMessageTime: string;
  lastCheckinTime: string;
  pendingItems: string[];
}

async function loadState(): Promise<CheckinState> {
  try {
    const content = await readFile(STATE_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return {
      lastMessageTime: new Date().toISOString(),
      lastCheckinTime: "",
      pendingItems: [],
    };
  }
}

async function saveState(state: CheckinState): Promise<void> {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

// ============================================================
// CONTEXT GATHERING
// ============================================================

async function getActiveGoals(): Promise<string[]> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return [];

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data, error } = await supabase
      .from("memory")
      .select("content, deadline")
      .eq("type", "goal")
      .order("created_at", { ascending: false })
      .limit(5);

    if (error || !data?.length) return [];

    return data.map((g: { content: string; deadline?: string }) => {
      const deadline = g.deadline
        ? ` (deadline: ${new Date(g.deadline).toLocaleDateString()})`
        : "";
      return `${g.content}${deadline}`;
    });
  } catch {
    return [];
  }
}

async function getRecentMessageCount(): Promise<number> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return 0;

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);

    const { count } = await supabase
      .from("messages")
      .select("id", { count: "exact", head: true })
      .gte("created_at", fourHoursAgo.toISOString());

    return count || 0;
  } catch {
    return 0;
  }
}

// ============================================================
// CLAUDE DECISION
// ============================================================

async function askClaudeToDecide(): Promise<{
  shouldCheckin: boolean;
  message: string;
}> {
  const state = await loadState();
  const goals = await getActiveGoals();
  const recentMessages = await getRecentMessageCount();

  const now = new Date();
  const hour = parseInt(
    now.toLocaleTimeString("en-US", { hour: "numeric", hour12: false, timeZone: USER_TIMEZONE })
  );
  const timeContext = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";

  const hoursSinceLastCheckin = state.lastCheckinTime
    ? (now.getTime() - new Date(state.lastCheckinTime).getTime()) / (1000 * 60 * 60)
    : 999;

  const userName = USER_NAME;
  const prompt = `You are a proactive AI assistant deciding whether to check in with ${userName} via a Telegram group chat.

CONTEXT:
- Current time: ${now.toLocaleTimeString("en-US", { timeZone: USER_TIMEZONE })} (${timeContext})
- Hours since last check-in: ${hoursSinceLastCheckin.toFixed(1)}
- Messages in last 4 hours: ${recentMessages}
- Active goals: ${goals.length > 0 ? goals.join("; ") : "None tracked"}
- Pending follow-ups: ${state.pendingItems.length > 0 ? state.pendingItems.join("; ") : "None"}

RULES:
1. Maximum 2 check-ins per day — do not be annoying
2. Only check in if there is a concrete reason (approaching deadline, long silence with pending goals, useful reminder)
3. Be brief and genuinely helpful, not intrusive
4. Do not check in during likely deep-work hours (10 AM - 12 PM, 2 PM - 4 PM) unless urgent
5. If nothing warrants a message, respond with NO

RESPOND IN THIS EXACT FORMAT:
DECISION: YES or NO
MESSAGE: [Your short, helpful message if YES, or "none" if NO]
REASON: [One line explaining your decision]`;

  try {
    // Remove CLAUDECODE to prevent nested session detection
    const env = { ...process.env };
    delete env.CLAUDECODE;

    const proc = spawn([CLAUDE_PATH, "-p", prompt, "--output-format", "text"], {
      stdout: "pipe",
      stderr: "pipe",
      env: env,
    });

    const output = await new Response(proc.stdout).text();

    const decisionMatch = output.match(/DECISION:\s*(YES|NO)/i);
    const messageMatch = output.match(/MESSAGE:\s*(.+?)(?=\nREASON:|$)/is);
    const reasonMatch = output.match(/REASON:\s*(.+)/is);

    const shouldCheckin = decisionMatch?.[1]?.toUpperCase() === "YES";
    const message = messageMatch?.[1]?.trim() || "";
    const reason = reasonMatch?.[1]?.trim() || "";

    console.log(`Decision: ${shouldCheckin ? "YES" : "NO"}`);
    console.log(`Reason: ${reason}`);

    return { shouldCheckin, message };
  } catch (error) {
    console.error("Claude error:", error);
    return { shouldCheckin: false, message: "" };
  }
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("Running Smart Check-in...");

  if (!validateGroup("GENERAL")) {
    console.error("Cannot run — GENERAL group not configured");
    console.error("Set chatId for the 'GENERAL' agent in config/agents.json");
    process.exit(0); // graceful skip — PM2 will retry on next cron cycle
  }

  const { shouldCheckin, message } = await askClaudeToDecide();

  if (shouldCheckin && message && message !== "none") {
    console.log("Sending check-in to General group...");
    await sendAndRecord(GROUPS.GENERAL.chatId, message, { routineName: 'smart-checkin', agentId: 'general-assistant', topicId: GROUPS.GENERAL.topicId });

    const state = await loadState();
    state.lastCheckinTime = new Date().toISOString();
    await saveState(state);

    console.log("Check-in sent!");
  } else {
    console.log("No check-in needed right now");
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("Error running smart check-in:", error);
    process.exit(0); // exit 0 so PM2 does not immediately restart — next run at scheduled cron time
  });
}
