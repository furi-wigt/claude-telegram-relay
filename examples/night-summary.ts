/**
 * Night Summary - Daily Activity Review at 11pm
 *
 * Sends a structured reflection at 11pm Singapore time:
 * - Key activities and accomplishments
 * - Progress on active goals
 * - Lessons learned and insights
 * - Areas for improvement
 * - Action items for tomorrow
 *
 * Schedule this with:
 * - macOS: launchd (see daemon/night-summary.plist)
 * - Linux: cron or systemd timer
 * - Windows: Task Scheduler
 *
 * Run manually: bun run examples/night-summary.ts
 */

import { createClient } from "@supabase/supabase-js";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";

// ============================================================
// TELEGRAM HELPER
// ============================================================

async function sendTelegram(message: string): Promise<boolean> {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: message,
          parse_mode: "Markdown",
        }),
      }
    );

    return response.ok;
  } catch (error) {
    console.error("Telegram error:", error);
    return false;
  }
}

// ============================================================
// DATA FETCHERS
// ============================================================

interface Message {
  id: number;
  content: string;
  role: "user" | "assistant";
  created_at: string;
}

interface Fact {
  id: number;
  content: string;
  created_at: string;
}

interface Goal {
  id: number;
  goal_text: string;
  deadline?: string;
  completed: boolean;
  completed_at?: string;
}

async function getTodaysMessages(): Promise<Message[]> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // Get messages from today (Singapore time)
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from("messages")
    .select("id, content, role, created_at")
    .gte("created_at", startOfDay.toISOString())
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Error fetching messages:", error);
    return [];
  }

  return data || [];
}

async function getTodaysFacts(): Promise<Fact[]> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from("memory")
    .select("id, content, created_at")
    .eq("type", "fact")
    .gte("created_at", startOfDay.toISOString())
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Error fetching facts:", error);
    return [];
  }

  return data || [];
}

async function getActiveGoals(): Promise<Goal[]> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  const { data, error } = await supabase
    .from("memory")
    .select("id, content, created_at")
    .eq("type", "goal")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Error fetching goals:", error);
    return [];
  }

  // Parse goal data from content JSON
  return (data || []).map((row) => {
    try {
      const parsed = JSON.parse(row.content);
      return {
        id: row.id,
        goal_text: parsed.goal_text || parsed.text || "",
        deadline: parsed.deadline,
        completed: parsed.completed || false,
        completed_at: parsed.completed_at,
      };
    } catch {
      return {
        id: row.id,
        goal_text: row.content,
        deadline: undefined,
        completed: false,
      };
    }
  });
}

async function getTodaysCompletedGoals(): Promise<Goal[]> {
  const allGoals = await getActiveGoals();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  return allGoals.filter(
    (goal) =>
      goal.completed &&
      goal.completed_at &&
      new Date(goal.completed_at) >= startOfDay
  );
}

// ============================================================
// CLAUDE ANALYSIS
// ============================================================

async function analyzeDay(
  messages: Message[],
  facts: Fact[],
  activeGoals: Goal[],
  completedGoals: Goal[]
): Promise<string> {
  // Build context for Claude
  const messagesSummary =
    messages.length > 0
      ? messages
          .map((m) => `[${m.role}]: ${m.content.substring(0, 200)}`)
          .join("\n")
      : "No messages today";

  const factsSummary =
    facts.length > 0 ? facts.map((f) => `- ${f.content}`).join("\n") : "None";

  const goalsSummary =
    activeGoals.length > 0
      ? activeGoals.map((g) => `- ${g.goal_text}`).join("\n")
      : "None";

  const completedSummary =
    completedGoals.length > 0
      ? completedGoals.map((g) => `- ${g.goal_text}`).join("\n")
      : "None";

  const prompt = `You are analyzing Furi's day. It is 11pm Singapore time.

**Today's activity:**
${messagesSummary}

**New facts learned:**
${factsSummary}

**Active goals:**
${goalsSummary}

**Goals completed today:**
${completedSummary}

Generate a structured reflection with these sections:
1. **Key Accomplishments** - What got done today? (2-3 bullet points)
2. **Goal Progress** - How did active goals advance? (brief status update)
3. **Insights & Learnings** - What was learned or discovered? (1-2 insights)
4. **Areas for Improvement** - What could have been better? (1-3 specific, actionable points)
5. **Tomorrow's Priorities** - Based on today, what should tomorrow focus on? (top 3 items)

Keep it concise but actionable. Use a reflective, coaching tone. Focus on what matters.

If today was light on activity, be brief and encouraging. If it was significant, provide detailed analysis.`;

  try {
    // Call Claude via API (assuming you have @anthropic-ai/sdk installed)
    // For this example, we'll use a simple fetch to Claude API
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

    if (!ANTHROPIC_API_KEY) {
      console.error("Missing ANTHROPIC_API_KEY");
      return "⚠️ Cannot generate summary - API key not configured";
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Claude API error:", errorText);
      return "⚠️ Failed to generate summary";
    }

    const data = await response.json();
    return data.content[0].text;
  } catch (error) {
    console.error("Analysis error:", error);
    return "⚠️ Analysis failed";
  }
}

// ============================================================
// BUILD SUMMARY
// ============================================================

async function buildSummary(): Promise<string> {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const sections: string[] = [];

  // Header
  sections.push(`🌙 **Day Review — ${dateStr}**\n`);

  // Fetch data
  const [messages, facts, activeGoals, completedGoals] = await Promise.all([
    getTodaysMessages(),
    getTodaysFacts(),
    getActiveGoals(),
    getTodaysCompletedGoals(),
  ]);

  // Generate Claude analysis
  const analysis = await analyzeDay(
    messages,
    facts,
    activeGoals,
    completedGoals
  );
  sections.push(analysis);

  // Footer
  sections.push(
    "\n---\n_Reply to reflect further, or let's talk tomorrow morning._"
  );

  return sections.join("\n");
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("Building night summary...");

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID");
    process.exit(1);
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY");
    process.exit(1);
  }

  const summary = await buildSummary();

  console.log("Sending summary...");
  const success = await sendTelegram(summary);

  if (success) {
    console.log("Summary sent successfully!");
  } else {
    console.error("Failed to send summary");
    process.exit(1);
  }
}

main();

// ============================================================
// LAUNCHD PLIST FOR SCHEDULING (macOS)
// ============================================================
/*
Save this as ~/Library/LaunchAgents/com.claude.night-summary.plist:

<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claude.night-summary</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/YOUR_USERNAME/.bun/bin/bun</string>
        <string>run</string>
        <string>examples/night-summary.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/claude-telegram-relay</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/Users/YOUR_USERNAME/.bun/bin</string>
    </dict>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>23</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>/tmp/night-summary.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/night-summary.error.log</string>
</dict>
</plist>

Load with: launchctl load ~/Library/LaunchAgents/com.claude.night-summary.plist
Unload with: launchctl unload ~/Library/LaunchAgents/com.claude.night-summary.plist
Check status: launchctl list | grep night-summary
View logs: tail -f /tmp/night-summary.log
*/

// ============================================================
// CRON FOR SCHEDULING (Linux)
// ============================================================
/*
Add to crontab with: crontab -e

# Run at 11:00 PM every day (Singapore time - adjust TZ if needed)
0 23 * * * cd /path/to/claude-telegram-relay && /home/USER/.bun/bin/bun run examples/night-summary.ts >> /tmp/night-summary.log 2>&1
*/
