# Adding New PM2 Routines

This guide shows how to add new scheduled routines managed by PM2.

## Step 1: Create the Routine Script

Create a TypeScript file in the `routines/` directory:

```typescript
// routines/my-routine.ts
import { callRoutineModel } from "../src/routines/routineModel.ts";
import { sendAndRecord } from "../src/utils/routineMessage.ts";

async function main() {
  console.log("Running my routine...");

  // Your routine logic here
  // Use callRoutineModel() for MLX text generation
  // Use sendAndRecord() to send Telegram messages

  console.log("Routine completed successfully");
}

// Entry guard — handles PM2's require() issue with import.meta.main
const _isEntry =
  import.meta.main ||
  process.env.pm_exec_path === import.meta.url?.replace("file://", "");

if (_isEntry) {
  main().catch((error) => {
    console.error("Error running:", error);
    process.exit(0); // exit 0 so PM2 does not immediately restart
  });
}
```

**Why the entry guard?** PM2 loads scripts via `require()`, which causes `import.meta.main` to be `false`. The guard checks both `import.meta.main` (direct `bun run`) and the PM2 exec path so the routine runs correctly in both contexts.

**Why `process.exit(0)` on error?** Exiting with code 0 prevents PM2 from immediately restarting a failed one-shot cron job. The error is logged and can be reviewed without triggering a restart loop.

## Step 2: Add to ecosystem.config.cjs

Add an entry to the `apps` array in `ecosystem.config.cjs`:

```javascript
{
  name: "my-routine",
  script: "routines/my-routine.ts",
  interpreter: "bun",
  cron_restart: "0 8 * * *",  // Run daily at 8 AM
  autorestart: false,          // One-shot cron job
  watch: false,
  env: {
    NODE_ENV: "production",
    // Add any routine-specific env vars here
  }
}
```

### Configuration Options

| Option | Value | Use case |
|--------|-------|----------|
| `autorestart: false` | One-shot cron jobs | Routines that run, complete, and exit (morning-summary, night-summary) |
| `autorestart: true` | Always-on services | Services that must stay running (telegram-relay, qdrant, mlx) |
| `cron_restart` | Cron expression | Schedule for when PM2 should start the script |
| `interpreter` | `"bun"` | Always use `bun` as the interpreter |
| `watch` | `false` | Always `false` for routines |

### Cron Expression Examples

```
"0 7 * * *"       # Daily at 7 AM
"0 23 * * *"      # Daily at 11 PM
"*/30 * * * *"    # Every 30 minutes
"0 */2 * * *"     # Every 2 hours
"0 3 * * *"       # Daily at 3 AM
"0 * * * *"       # Every hour
"0 9 * * 1"       # Every Monday at 9 AM
```

## Step 3: Start the Routine

Start only your new routine (not all services):

```bash
npx pm2 start ecosystem.config.cjs --only my-routine
```

Verify it is registered:

```bash
npx pm2 status
```

## Step 4: Test Manually

Run the script directly to verify it works before relying on the cron schedule:

```bash
bun run routines/my-routine.ts
```

Check PM2 logs after a scheduled run:

```bash
npx pm2 logs my-routine --lines 50
```

Log files are written to `~/.claude-relay/logs/`.

## Key Utilities

### Text Generation (MLX)

Use `callRoutineModel()` from `src/routines/routineModel.ts` for local text generation via the MLX server:

```typescript
import { callRoutineModel } from "../src/routines/routineModel.ts";

const response = await callRoutineModel("Summarize today's tasks");
```

### Sending Telegram Messages

Use `sendAndRecord()` from `src/utils/routineMessage.ts` to send messages and log them to the database:

```typescript
import { sendAndRecord } from "../src/utils/routineMessage.ts";

await sendAndRecord(chatId, "Your message here", { parse_mode: "Markdown" });
```

## PM2 Commands Reference

| Command | What it does |
|---------|-------------|
| `npx pm2 start ecosystem.config.cjs --only my-routine` | Start a single service |
| `npx pm2 restart my-routine` | Restart by name |
| `npx pm2 stop my-routine` | Stop without removing |
| `npx pm2 delete my-routine` | Remove from PM2 entirely |
| `npx pm2 logs my-routine` | View logs (stdout + stderr) |
| `npx pm2 logs my-routine --err` | View error logs only |
| `npx pm2 status` | Show all services and their status |

## Safety Rules

These rules prevent accidentally taking the main bot offline:

1. **NEVER use `npx pm2 reload ecosystem.config.cjs` or `npx pm2 restart ecosystem.config.cjs`** -- this restarts ALL services including `telegram-relay`, causing the bot to go offline or enter restart loops.
2. **Always restart by service name**: `npx pm2 restart my-routine`.
3. **NEVER modify the `interpreter` or exec patterns** in `ecosystem.config.cjs` -- a previous attempt to use `interpreter: "none"` with `/bin/sh -c 'bun run script.ts'` broke all services.
4. **Treat `telegram-relay` as sacred** -- never restart it without explicit user confirmation.

## Existing Routines for Reference

| Routine | Schedule | autorestart | Description |
|---------|----------|-------------|-------------|
| `morning-summary` | `0 7 * * *` (7 AM daily) | `false` | Morning briefing with weather, goals, calendar |
| `night-summary` | `0 23 * * *` (11 PM daily) | `false` | End-of-day summary and reflection |
| `smart-checkin` | `*/30 * * * *` (every 30 min) | `false` | Context-aware check-ins during waking hours |
| `watchdog` | `0 */2 * * *` (every 2 hours) | `false` | Health monitor for all services |
| `memory-cleanup` | `0 3 * * *` (3 AM daily) | `false` | Prune stale memory entries |
| `orphan-gc` | `0 * * * *` (hourly) | `false` | Garbage-collect orphaned records |

Browse these scripts in `routines/` for patterns and conventions.

## Troubleshooting

### Routine Not Running on Schedule

1. Check PM2 status: `npx pm2 status` -- is the routine listed and in "online" or "stopped" state?
2. Verify cron expression: use [crontab.guru](https://crontab.guru) to validate your expression.
3. Check if PM2 is running: `npx pm2 ping`.
4. Times use **local system time**, not UTC. Verify with `date`.

### Routine Fails Silently

1. Check logs: `npx pm2 logs my-routine --lines 100`.
2. Run manually: `bun run routines/my-routine.ts` to see errors in real time.
3. Verify environment variables are set in `.env` or in the `env` block of `ecosystem.config.cjs`.

### Routine Keeps Restarting

1. For one-shot cron jobs, ensure `autorestart: false` in `ecosystem.config.cjs`.
2. Ensure the entry guard uses `process.exit(0)` on error (not `process.exit(1)`).
3. Check restart count: `npx pm2 status` -- if restart count is high, the script is crashing and PM2 is restarting it.

## Best Practices

1. **Always use the entry guard pattern** -- copy it exactly from Step 1 above.
2. **Exit with code 0** -- even on errors, to prevent PM2 restart loops for cron jobs.
3. **Log success and failure clearly** -- include the routine name in log messages for easy filtering.
4. **Test manually first** -- run `bun run routines/my-routine.ts` before relying on cron.
5. **Keep routines idempotent** -- safe to run multiple times without side effects.
6. **Use existing utilities** -- `callRoutineModel()` for text generation, `sendAndRecord()` for Telegram messages.
7. **Start only your routine** -- use `--only my-routine` when starting, never restart all services.

## Reference

- **Routine scripts**: `routines/`
- **PM2 config**: `ecosystem.config.cjs`
- **Routine model helper**: `src/routines/routineModel.ts`
- **Message helper**: `src/utils/routineMessage.ts`
- **Logs**: `~/.claude-relay/logs/`
- **Developer guide**: `routines/CLAUDE.md` (code patterns and PM2 safety rules)
- **User journey**: `routines/user_journey.md` (creating routines via Telegram)
