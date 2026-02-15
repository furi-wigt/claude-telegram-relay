# Watchdog System

The watchdog monitors all your scheduled jobs and alerts you via Telegram if anything fails.

## What It Monitors

- **Morning Briefing** (7:00 AM daily) - ETF stock analysis
- **Night Summary** (11:00 PM daily) - Daily review and reflection
- Future scheduled jobs you add

## How It Works

The watchdog runs **6 times per day** at:
- 12:15 AM (after midnight, checks if night summary ran)
- 6:00 AM (early morning check)
- 8:00 AM (verifies morning briefing ran)
- 12:00 PM (midday check)
- 6:00 PM (evening check)
- 11:30 PM (verifies night summary ran)

### What It Checks

For each job:
1. **Service Status** - Is the job loaded in launchd?
2. **Execution** - Did it run when scheduled?
3. **Success** - Did it complete without errors?
4. **Logs** - Are there error messages in the log files?

### Alert Logic

- **Smart Throttling** - Won't spam you. Each issue triggers ONE alert per 6 hours.
- **Overdue Detection** - Alerts if a job is more than 30 minutes late.
- **Error Detection** - Scans logs for common error patterns.
- **Success Validation** - Checks that jobs actually completed successfully.

## Installation

Already installed! When you ran:
```bash
bun run setup:launchd -- --service watchdog
```

The watchdog is now running in the background.

## Verify It's Running

```bash
# Check if watchdog is loaded
launchctl list | grep watchdog

# View watchdog logs
tail -f logs/com.claude.watchdog.log

# Run watchdog manually (for testing)
bun run setup/watchdog.ts
```

## What Alerts Look Like

When the watchdog detects issues, you'll get a Telegram message like:

```
🚨 Watchdog Alert

**Morning Briefing** is overdue.
Schedule: Daily at 7:00 AM
Last run: Never
Max delay: 30 minutes

---

**Night Summary** has errors in logs.
```
Error: Missing ANTHROPIC_API_KEY
```
```

## Adding New Jobs to Monitor

Edit `setup/watchdog.ts` and add to the `JOBS` array:

```typescript
{
  name: "My New Job",
  label: "com.claude.my-job",       // launchd service label
  script: "examples/my-job.ts",     // script path
  schedule: "Daily at 9:00 AM",     // human-readable
  expectedHours: [9],               // when it should run
  maxDelayMinutes: 30,              // acceptable delay
  checkLogFile: true                // should we scan logs?
}
```

## State Persistence

The watchdog maintains state in `logs/watchdog-state.json`:
- Last check time
- Alert history (prevents spam)
- Recent issues

This file is automatically managed - no manual intervention needed.

## Self-Monitoring

The watchdog checks its own health on every run. If the watchdog itself fails to run, the scheduled jobs will still execute, but you won't get alerts if they fail.

To verify the watchdog is healthy:
```bash
launchctl list | grep com.claude.watchdog
```

You should see it in the list with a status of `0`.

## Troubleshooting

### Watchdog not running
```bash
# Reload the service
bun run setup:launchd -- --service watchdog
```

### Too many alerts
The watchdog throttles alerts to once per 6 hours per issue. If you're getting spammed:
1. Check `logs/watchdog-state.json` for alert history
2. Fix the underlying issue (the watchdog is telling you something is broken)

### False positives
If a job legitimately failed but you want to suppress the alert:
1. Fix the job
2. Wait 6 hours (alert will not repeat for the same issue)
3. Or delete `logs/watchdog-state.json` to reset alert state

### Missing alerts
If you expect an alert but didn't get one:
1. Check `logs/com.claude.watchdog.log` to see what the watchdog detected
2. Run manually: `bun run setup/watchdog.ts`
3. Verify Telegram credentials in `.env`

## Log Files

Each service writes to its own log file in `logs/`:
- `com.claude.morning-briefing.log` - Morning briefing output
- `com.claude.night-summary.log` - Night summary output
- `com.claude.watchdog.log` - Watchdog's own logs
- `watchdog-state.json` - Watchdog state (alert history)

## Uninstalling

To stop the watchdog:
```bash
launchctl unload ~/Library/LaunchAgents/com.claude.watchdog.plist
rm ~/Library/LaunchAgents/com.claude.watchdog.plist
```

Or reinstall everything:
```bash
bun run setup:launchd -- --service all
```
