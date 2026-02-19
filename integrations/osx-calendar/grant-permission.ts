/**
 * One-time Calendar permission helper.
 * Run this interactively BEFORE starting PM2 to grant macOS Calendar access.
 *
 * Usage: bun run integrations/osx-calendar/grant-permission.ts
 */

import { checkCalendarAccess, listCalendarsJXA } from "./jxa.ts";

async function main() {
  if (process.platform !== "darwin") {
    console.error("This script requires macOS.");
    process.exit(1);
  }

  console.log("Requesting macOS Calendar access...");
  console.log("If prompted, click 'Allow' in the system dialog.\n");

  const hasAccess = await checkCalendarAccess();

  if (!hasAccess) {
    console.error(
      "❌ Calendar access denied.\n" +
      "Go to System Settings → Privacy & Security → Calendars\n" +
      "and enable access for this app."
    );
    process.exit(1);
  }

  const calendars = await listCalendarsJXA();
  console.log(`✅ Calendar access granted. Found ${calendars.length} calendar(s):`);
  for (const cal of calendars) {
    console.log(`  • ${cal.title}`);
  }
  console.log("\nPermission cached — PM2 services can now read your calendar.");
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
