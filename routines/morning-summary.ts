#!/usr/bin/env bun

/**
 * Morning Summary Routine
 *
 * Schedule: 7:00 AM daily
 * Target: General AI Assistant group
 *
 * Sends a morning overview to the General group. The General assistant
 * agent processes it and provides a personalized daily briefing.
 *
 * Run manually: bun run routines/morning-summary.ts
 */

import { sendToGroup } from "../src/utils/sendToGroup.ts";
import { GROUPS, validateGroup } from "../src/config/groups.ts";

async function getDailySummaryData(): Promise<{
  date: string;
  dayOfWeek: string;
  calendarEvents: number;
  pendingTasks: number;
  unreadMessages: number;
}> {
  // TODO: Integrate with calendar API, task manager, email
  // For now, returns structure that the agent will enhance with its context
  const now = new Date();
  return {
    date: now.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    }),
    dayOfWeek: now.toLocaleDateString("en-US", { weekday: "long" }),
    calendarEvents: 0,
    pendingTasks: 0,
    unreadMessages: 0,
  };
}

async function main() {
  console.log("Running Morning Summary...");

  if (!validateGroup("GENERAL")) {
    console.error("Cannot run — GENERAL group not configured in .env");
    console.error("Set GROUP_GENERAL_CHAT_ID in your .env file");
    process.exit(1);
  }

  const data = await getDailySummaryData();

  const message = `Good morning! Here is your daily overview for ${data.dayOfWeek}, ${data.date}.

Calendar events today: ${data.calendarEvents}
Pending tasks: ${data.pendingTasks}
Unread messages: ${data.unreadMessages}

Please provide a brief summary and suggest priorities for today based on what you know about my schedule, goals, and recent conversations.`;

  await sendToGroup(GROUPS.GENERAL, message);
  console.log("Morning summary sent to General group");
}

main().catch((error) => {
  console.error("Error running morning summary:", error);
  process.exit(1);
});
