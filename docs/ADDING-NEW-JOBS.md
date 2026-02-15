# Adding New Scheduled Jobs

This guide shows how to add new scheduled jobs that run automatically and are monitored by the watchdog.

## Step 1: Create Your Script

Create your script in the `examples/` directory:

```typescript
// examples/my-new-job.ts
import * as fs from "fs";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";

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
    console.error("Error:", error);
    return false;
  }
}

async function main() {
  console.log("Running my new job...");

  // Your job logic here
  const message = "🎯 My new job completed successfully!";

  const success = await sendTelegram(message);

  if (success) {
    console.log("Job completed successfully");
  } else {
    console.error("Job failed");
    process.exit(1);
  }
}

main();
```

**Important Success Indicators:**
- Always log "success", "completed", or "done" on successful completion
- Call `process.exit(1)` on failures so the watchdog can detect errors
- Use try/catch and proper error handling

## Step 2: Add to launchd Configuration

Edit `setup/configure-launchd.ts` and add your service to the `SERVICES` object:

```typescript
const SERVICES: Record<string, ServiceConfig> = {
  // ... existing services ...

  myjob: {
    label: "com.claude.my-new-job",
    script: "examples/my-new-job.ts",
    keepAlive: false,
    calendarIntervals: [
      { Hour: 14, Minute: 0 },  // 2:00 PM daily
    ],
    description: "My new job (daily at 2pm)"
  },
};
```

**Configuration Options:**

- `label` - Unique identifier (use com.claude.* naming)
- `script` - Path to your TypeScript file (relative to project root)
- `keepAlive` - Set to `true` for always-running services, `false` for scheduled jobs
- `calendarIntervals` - Array of times when job should run
  - `Hour` - 0-23 (24-hour format)
  - `Minute` - 0-59
  - Can specify multiple intervals for jobs that run multiple times per day
- `description` - Human-readable description shown during setup

**Multiple Run Times Example:**
```typescript
calendarIntervals: [
  { Hour: 9, Minute: 0 },   // 9:00 AM
  { Hour: 12, Minute: 0 },  // 12:00 PM
  { Hour: 15, Minute: 0 },  // 3:00 PM
],
```

## Step 3: Add to Watchdog Monitoring

Edit `setup/watchdog.ts` and add your job to the `JOBS` array:

```typescript
const JOBS: JobSchedule[] = [
  // ... existing jobs ...

  {
    name: "My New Job",
    label: "com.claude.my-new-job",
    script: "examples/my-new-job.ts",
    schedule: "Daily at 2:00 PM",
    expectedHours: [14],  // When job should have run (24-hour format)
    maxDelayMinutes: 30,  // How late before alerting
    checkLogFile: true    // Should watchdog scan logs for errors?
  },
];
```

**Watchdog Configuration:**

- `name` - Human-readable name for alerts
- `label` - Must match the launchd label from Step 2
- `script` - Must match the script path from Step 2
- `schedule` - Human-readable schedule (for alerts)
- `expectedHours` - Array of hours (0-23) when job should have run
  - For multiple daily runs: `[9, 12, 15]`
  - For single run: `[14]`
- `maxDelayMinutes` - Grace period before marking job as overdue
- `checkLogFile` - Set to `true` to enable log error scanning

**Example for Multiple Daily Runs:**
```typescript
{
  name: "Frequent Check",
  label: "com.claude.frequent-check",
  script: "examples/frequent-check.ts",
  schedule: "Every 3 hours (9am, 12pm, 3pm)",
  expectedHours: [9, 12, 15],
  maxDelayMinutes: 30,
  checkLogFile: true
}
```

## Step 4: Install the Service

Run the launchd setup script:

```bash
bun run setup:launchd -- --service myjob
```

This will:
1. Generate the plist file
2. Load it into launchd
3. Start scheduling the job

**Verify Installation:**
```bash
# Check if service is loaded
launchctl list | grep com.claude.my-new-job

# View the generated plist
cat ~/Library/LaunchAgents/com.claude.my-new-job.plist
```

## Step 5: Test Manually

Before waiting for the scheduled time, test your script manually:

```bash
# Run the script directly
bun run examples/my-new-job.ts

# Check for success message
echo $?  # Should be 0 for success
```

Check the logs:
```bash
# View output
tail -f logs/com.claude.my-new-job.log

# Check for errors
tail -f logs/com.claude.my-new-job.error.log
```

## Step 6: Test Watchdog Detection

Run the watchdog manually to verify it detects your job:

```bash
bun run setup/watchdog.ts
```

You should see output like:
```
Checking: My New Job
  Running: ✓
  Last run: Never
  Should have run: No
  Overdue: No
```

## Complete Example: Weekly Report

Here's a complete example of adding a weekly report that runs every Monday at 9 AM:

### 1. Create Script
```typescript
// examples/weekly-report.ts
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";

async function sendTelegram(message: string): Promise<boolean> {
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
}

async function main() {
  console.log("Generating weekly report...");

  const report = `📊 **Weekly Report**\n\nWeek of ${new Date().toLocaleDateString()}\n\n...your report content...`;

  const success = await sendTelegram(report);

  if (success) {
    console.log("Weekly report sent successfully");
  } else {
    console.error("Failed to send weekly report");
    process.exit(1);
  }
}

main();
```

### 2. Add to launchd (configure-launchd.ts)
```typescript
weeklyreport: {
  label: "com.claude.weekly-report",
  script: "examples/weekly-report.ts",
  keepAlive: false,
  calendarIntervals: [
    { Weekday: 1, Hour: 9, Minute: 0 }  // Monday at 9am
  ],
  description: "Weekly report (Mondays at 9am)"
}
```

### 3. Add to Watchdog (watchdog.ts)
```typescript
{
  name: "Weekly Report",
  label: "com.claude.weekly-report",
  script: "examples/weekly-report.ts",
  schedule: "Mondays at 9:00 AM",
  expectedHours: [9],
  maxDelayMinutes: 60,  // Longer grace period for weekly jobs
  checkLogFile: true
}
```

### 4. Install
```bash
bun run setup:launchd -- --service weeklyreport
```

## Common Patterns

### Data Fetching Job
```typescript
// Fetch data, save to file, send summary
async function main() {
  const data = await fetchData();
  fs.writeFileSync("/path/to/data.json", JSON.stringify(data));
  await sendTelegram("Data updated successfully");
  console.log("Data fetch completed successfully");
}
```

### Conditional Notification
```typescript
// Only send message if condition met
async function main() {
  const result = await checkCondition();

  if (result.shouldNotify) {
    await sendTelegram(result.message);
  }

  // Always log success even if no notification sent
  console.log("Check completed successfully");
}
```

### External API Integration
```typescript
// Call external service, handle errors gracefully
async function main() {
  try {
    const response = await fetch("https://api.example.com/data");
    const data = await response.json();

    await sendTelegram(`Received ${data.items.length} items`);
    console.log("API call completed successfully");
  } catch (error) {
    console.error("API call failed:", error);
    await sendTelegram("⚠️ API integration failed");
    process.exit(1);
  }
}
```

## Troubleshooting

### Job Not Running
1. Check if loaded: `launchctl list | grep com.claude.your-job`
2. Check plist file: `cat ~/Library/LaunchAgents/com.claude.your-job.plist`
3. Reinstall: `bun run setup:launchd -- --service yourjob`

### Job Running But Failing
1. Check logs: `tail -100 logs/com.claude.your-job.error.log`
2. Run manually: `bun run examples/your-job.ts`
3. Check environment variables in `.env`

### Watchdog Not Detecting Failures
1. Verify job is in watchdog JOBS array
2. Check log file path matches: `logs/com.claude.your-job.log`
3. Ensure script logs success/error keywords
4. Run watchdog manually: `bun run setup/watchdog.ts`

### Wrong Schedule
Times are in **local system time**, not UTC. Check your timezone:
```bash
date
```

To change schedule, edit `configure-launchd.ts`, then reinstall:
```bash
bun run setup:launchd -- --service yourjob
```

## Best Practices

1. **Always log success** - Use "success", "completed", or "done" in output
2. **Exit with code 1 on failure** - `process.exit(1)` so watchdog detects errors
3. **Use try/catch** - Handle errors gracefully, send error notifications
4. **Test manually first** - Run `bun run examples/your-job.ts` before scheduling
5. **Start with longer delay windows** - Use 30-60 min grace periods initially
6. **Monitor first week** - Check logs daily when first deployed
7. **Document what your job does** - Add comments explaining purpose and behavior
8. **Keep jobs idempotent** - Safe to run multiple times without side effects

## Reference

- **Service Config**: `setup/configure-launchd.ts`
- **Watchdog Config**: `setup/watchdog.ts`
- **plist Files**: `~/Library/LaunchAgents/com.claude.*.plist`
- **Logs**: `logs/com.claude.*.log` and `logs/com.claude.*.error.log`
- **Examples**: `examples/` directory
