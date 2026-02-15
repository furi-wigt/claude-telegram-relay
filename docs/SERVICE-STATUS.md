# Service Status Quick Reference

## Currently Running Services

| Service | Label | Schedule | Status |
|---------|-------|----------|--------|
| **Telegram Relay** | com.claude.telegram-relay | Always on | ✓ Running |
| **Morning Briefing** | com.claude.morning-briefing | Daily at 7:00 AM | ✓ Running |
| **Night Summary** | com.claude.night-summary | Daily at 11:00 PM | ✓ Running |
| **Watchdog** | com.claude.watchdog | 6x daily | ✓ Running |

## Quick Commands

### Check All Services
```bash
launchctl list | grep com.claude
```

### View Logs
```bash
# Telegram relay (main bot)
tail -f logs/com.claude.telegram-relay.log

# Morning briefing
tail -f logs/com.claude.morning-briefing.log

# Night summary
tail -f logs/com.claude.night-summary.log

# Watchdog
tail -f logs/com.claude.watchdog.log
```

### Restart a Service
```bash
# Unload
launchctl unload ~/Library/LaunchAgents/com.claude.SERVICE_NAME.plist

# Load
launchctl load ~/Library/LaunchAgents/com.claude.SERVICE_NAME.plist
```

### Reinstall All Services
```bash
bun run setup:launchd -- --service all
```

### Install Individual Services
```bash
# Telegram relay (main bot)
bun run setup:launchd -- --service relay

# Morning briefing
bun run setup:launchd -- --service briefing

# Night summary
bun run setup:launchd -- --service summary

# Watchdog
bun run setup:launchd -- --service watchdog
```

## Service Details

### Telegram Relay
- **Purpose**: Main bot that responds to your messages
- **Keep Alive**: Yes (restarts on crash)
- **Log**: `logs/com.claude.telegram-relay.log`

### Morning Briefing
- **Purpose**: Daily ETF stock analysis at 7 AM
- **Schedule**: 7:00 AM daily
- **Script**: `examples/morning-briefing-etf.ts`
- **Log**: `logs/com.claude.morning-briefing.log`

### Night Summary
- **Purpose**: Daily reflection at 11 PM
- **Schedule**: 11:00 PM daily
- **Script**: `examples/night-summary.ts`
- **Log**: `logs/com.claude.night-summary.log`

### Watchdog
- **Purpose**: Monitors all jobs and alerts on failures
- **Schedule**: 6 times daily (12:15 AM, 6 AM, 8 AM, 12 PM, 6 PM, 11:30 PM)
- **Script**: `setup/watchdog.ts`
- **Log**: `logs/com.claude.watchdog.log`
- **State**: `logs/watchdog-state.json`

## Troubleshooting

### Service Won't Start
1. Check the plist file exists:
   ```bash
   ls -l ~/Library/LaunchAgents/com.claude.*.plist
   ```

2. Check for errors in logs:
   ```bash
   tail -100 logs/com.claude.SERVICE_NAME.error.log
   ```

3. Reinstall:
   ```bash
   bun run setup:launchd -- --service SERVICE_NAME
   ```

### Service Running But Not Working
1. Check environment variables in `.env`
2. Test script manually:
   ```bash
   bun run examples/SCRIPT_NAME.ts
   ```
3. Check logs for errors

### Watchdog Alerts
If you get a watchdog alert:
1. Check the specific service log: `logs/com.claude.SERVICE_NAME.log`
2. Fix the underlying issue
3. Watchdog will auto-clear the alert once the job succeeds
4. Alerts throttle to once per 6 hours per issue

## Service Locations

- **Plist files**: `~/Library/LaunchAgents/com.claude.*.plist`
- **Scripts**: Project root (`src/`, `examples/`, `setup/`)
- **Logs**: `logs/` in project root
- **Environment**: `.env` in project root

## Adding New Services

See `setup/configure-launchd.ts` to add new scheduled jobs.

Example:
```typescript
myservice: {
  label: "com.claude.my-service",
  script: "examples/my-service.ts",
  keepAlive: false,
  calendarIntervals: [{ Hour: 14, Minute: 0 }],
  description: "My service (daily at 2pm)"
}
```

Then run:
```bash
bun run setup:launchd -- --service myservice
```

Don't forget to add it to the watchdog monitoring in `setup/watchdog.ts`.
