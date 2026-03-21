/**
 * One-time Calendar permission helper.
 * Run this interactively BEFORE starting PM2 to grant macOS Calendar access.
 *
 * Usage: bun run integrations/osx-calendar/grant-permission.ts
 */

import { checkCalendarAccess, listCalendarsJXA } from "./jxa.ts";

const TIMEOUT_MS = 10_000;

/** Wrap a promise with a timeout that rejects with a clear error message. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const timer = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Timed out after ${ms / 1000}s waiting for ${label}`)), ms)
  );
  return Promise.race([promise, timer]);
}

async function main() {
  if (process.platform !== "darwin") {
    console.error("This script requires macOS.");
    process.exit(1);
  }

  console.log("Requesting macOS Calendar access...");
  console.log("If prompted, click 'Allow' in the system dialog.\n");

  let hasAccess: boolean;
  try {
    hasAccess = await withTimeout(checkCalendarAccess(), TIMEOUT_MS, "Calendar permission check");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("Timed out")) {
      console.error(
        "❌ Calendar permission check timed out.\n" +
        "osascript did not respond within 10 seconds.\n" +
        "Check System Settings → Privacy & Security → Automation and ensure\n" +
        "this terminal app is allowed to control Calendar."
      );
    } else {
      console.error("❌ Calendar permission check failed:", msg);
    }
    process.exit(1);
  }

  if (!hasAccess) {
    console.error(
      "❌ Calendar access denied.\n" +
      "Open System Settings → Privacy & Security → Calendars\n" +
      "and enable access for Terminal (or your terminal app), then re-run this script."
    );
    process.exit(1);
  }

  let calendars: Awaited<ReturnType<typeof listCalendarsJXA>>;
  try {
    calendars = await withTimeout(listCalendarsJXA(), TIMEOUT_MS, "calendar list fetch");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("Timed out")) {
      console.error(
        "❌ Listing calendars timed out.\n" +
        "Calendar.app may be busy or unresponsive. Try re-running the script."
      );
    } else {
      console.error(
        "❌ Failed to list calendars.\n" +
        "Access appeared to be granted, but reading calendar data failed.\n" +
        "Error: " + msg
      );
    }
    process.exit(1);
  }

  console.log(`✅ Calendar access granted. Found ${calendars.length} calendar(s):`);
  for (const cal of calendars) {
    console.log(`  • ${cal.title}`);
  }
  console.log("\nPermission cached — PM2 services can now read your calendar.");
}

main().catch(err => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
