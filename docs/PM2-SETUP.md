# PM2 Service Management

This guide covers setting up the Claude Telegram Relay to run 24/7 using PM2 process manager.

## Why PM2?

PM2 is a production-grade process manager with:

- **Cross-platform**: Works on macOS, Linux, and Windows
- **Cron scheduling**: Built-in cron support for periodic jobs
- **Auto-restart**: Keeps processes alive, restarts on crash
- **Log management**: Centralized logging with rotation
- **Monitoring**: Real-time dashboard and metrics
- **Startup scripts**: Auto-start on boot

## Quick Start

### 1. Install Services

Install all services (relay + cron jobs):

```bash
bun run setup:pm2 -- --service all
```

Or install individual services:

```bash
bun run setup:pm2 -- --service relay      # Main bot only
bun run setup:pm2 -- --service briefing   # Morning briefing only
bun run setup:pm2 -- --service summary    # Night summary only
bun run setup:pm2 -- --service checkin    # Smart check-ins only
bun run setup:pm2 -- --service watchdog   # Watchdog monitor only
```

### 2. Enable Auto-Start on Boot

```bash
npx pm2 startup
# Follow the command it prints to enable startup
npx pm2 save
```

### 3. Verify Everything Works

```bash
npx pm2 status
```

You should see:

```
┌─────────────────┬────┬─────────┬──────┬──────┐
│ Name            │ id │ status  │ cpu  │ mem  │
├─────────────────┼────┼─────────┼──────┼──────┤
│ telegram-relay  │ 0  │ online  │ 0%   │ 50M  │
│ morning-briefing│ 1  │ stopped │ 0%   │ 0    │
│ night-summary   │ 2  │ stopped │ 0%   │ 0    │
│ smart-checkin   │ 3  │ stopped │ 0%   │ 0    │
│ watchdog        │ 4  │ stopped │ 0%   │ 0    │
└─────────────────┴────┴─────────┴──────┴──────┘
```

**Note**: Cron jobs show as "stopped" when not running. They auto-start at their scheduled time.

## Service Details

### telegram-relay (Always Running)

**Purpose**: Main bot that handles Telegram messages
**Type**: Persistent (always on)
**Auto-restart**: Yes
**Script**: `src/relay.ts`

```bash
npx pm2 logs telegram-relay  # View logs
npx pm2 restart telegram-relay  # Restart
```

### morning-briefing (Cron)

**Purpose**: Daily ETF stock market briefing
**Schedule**: 7:00 AM daily
**Cron**: `0 7 * * *`
**Script**: `examples/morning-briefing-etf.ts`

```bash
npx pm2 logs morning-briefing
```

### night-summary (Cron)

**Purpose**: End-of-day reflection and summary
**Schedule**: 11:00 PM daily
**Cron**: `0 23 * * *`
**Script**: `examples/night-summary.ts`

```bash
npx pm2 logs night-summary
```

### smart-checkin (Cron)

**Purpose**: Proactive check-ins when needed
**Schedule**: Every 30 minutes
**Cron**: `*/30 * * * *`
**Script**: `examples/smart-checkin.ts`

```bash
npx pm2 logs smart-checkin
```

### watchdog (Cron)

**Purpose**: Monitors all jobs, alerts on failures
**Schedule**: 6 times daily (12:15am, 6am, 8am, 12pm, 6pm, 11:30pm)
**Cron**: `15 0,6,8,12,18,23 * * *`
**Script**: `setup/watchdog.ts`

```bash
npx pm2 logs watchdog
```

## PM2 Commands Reference

### Status & Monitoring

```bash
npx pm2 status                # View all processes
npx pm2 list                  # Same as status
npx pm2 monit                 # Real-time monitoring dashboard
npx pm2 show telegram-relay   # Detailed info for one service
```

### Logs

```bash
npx pm2 logs                  # All logs (streaming)
npx pm2 logs telegram-relay   # Specific service logs
npx pm2 logs --lines 100      # Last 100 lines
npx pm2 flush                 # Clear all logs
```

### Control

```bash
npx pm2 start telegram-relay  # Start a service
npx pm2 stop telegram-relay   # Stop a service
npx pm2 restart telegram-relay # Restart a service
npx pm2 reload telegram-relay # Reload (zero-downtime for cluster mode)
npx pm2 delete telegram-relay # Remove from PM2

npx pm2 start all             # Start all services
npx pm2 stop all              # Stop all services
npx pm2 restart all           # Restart all services
npx pm2 delete all            # Remove all services
```

### Persistence

```bash
npx pm2 save                  # Save current process list
npx pm2 resurrect             # Restore saved process list
npx pm2 startup               # Generate startup script
npx pm2 unstartup             # Remove startup script
```

## Troubleshooting

### Service Not Starting

```bash
# Check logs for errors
npx pm2 logs telegram-relay --lines 50

# Verify script runs manually
bun run src/relay.ts

# Check environment variables
npx pm2 show telegram-relay
```

### Cron Job Not Running

```bash
# PM2 cron jobs run at scheduled time only
# Check if they ran by viewing logs
npx pm2 logs morning-briefing --lines 20

# Force a cron job to run now (for testing)
npx pm2 restart morning-briefing
```

### High Memory Usage

```bash
# View memory stats
npx pm2 monit

# Restart process to clear memory
npx pm2 restart telegram-relay

# Set memory limit (process auto-restarts if exceeded)
# This is already configured in ecosystem.config.js
```

### PM2 Not Found

```bash
# Install PM2 globally
npm install -g pm2

# Or use npx (slower but no install needed)
npx pm2 status
```

## Configuration

The PM2 configuration is in `ecosystem.config.js` (auto-generated):

```javascript
module.exports = {
  apps: [
    {
      name: "telegram-relay",
      script: "src/relay.ts",
      interpreter: "/Users/you/.bun/bin/bun",
      cwd: "/path/to/project",
      instances: 1,
      autorestart: true,
      max_memory_restart: "500M",
      env: {
        NODE_ENV: "production",
        PATH: "...",
        HOME: "...",
      },
      error_file: "logs/telegram-relay.error.log",
      out_file: "logs/telegram-relay.log",
    },
    {
      name: "morning-briefing",
      script: "examples/morning-briefing-etf.ts",
      cron_restart: "0 7 * * *",
      autorestart: false,
      // ... same structure
    },
    // ... other services
  ],
};
```

### Customizing Schedules

Edit `setup/configure-pm2.ts` and modify the cron expressions:

```typescript
const SERVICES: Record<string, ServiceConfig> = {
  checkin: {
    name: "smart-checkin",
    script: "examples/smart-checkin.ts",
    cron: "*/30 * * * *", // Change to "0 9,12,15,18 * * *" for 4x daily
    // ...
  },
};
```

Then re-run setup:

```bash
bun run setup:pm2 -- --service all
```

### Cron Expression Format

PM2 uses standard cron syntax:

```
*    *    *    *    *
┬    ┬    ┬    ┬    ┬
│    │    │    │    │
│    │    │    │    └─ Day of week (0-7, 0 or 7 = Sunday)
│    │    │    └────── Month (1-12)
│    │    └─────────── Day of month (1-31)
│    └──────────────── Hour (0-23)
└───────────────────── Minute (0-59)
```

Examples:

```bash
"0 7 * * *"           # Daily at 7:00 AM
"0 23 * * *"          # Daily at 11:00 PM
"*/30 * * * *"        # Every 30 minutes
"0 9,12,15,18 * * *"  # 4 times daily (9am, 12pm, 3pm, 6pm)
"0 0 * * 0"           # Weekly on Sunday at midnight
```

## Comparison: PM2 vs launchd

| Feature           | PM2                          | launchd (macOS)           |
| ----------------- | ---------------------------- | ------------------------- |
| **Platform**      | Cross-platform               | macOS only                |
| **Setup**         | `bun run setup:pm2`          | `bun run setup:launchd`   |
| **Cron**          | Built-in (`cron_restart`)    | `StartCalendarInterval`   |
| **Monitoring**    | `npx pm2 monit`              | Manual log tailing        |
| **Logs**          | `npx pm2 logs`               | Separate files in `logs/` |
| **Auto-restart**  | `autorestart: true`          | `KeepAlive: true`         |
| **Startup**       | `npx pm2 startup`            | Auto-loaded               |
| **Status**        | `npx pm2 status`             | `launchctl list`          |
| **Documentation** | Extensive, active community  | Apple docs                |
| **Learning curve** | Gentle                       | Steeper (plist XML)       |

**Recommendation**: Use PM2 for cross-platform compatibility and easier management. Use launchd if you prefer native macOS integration.

## Uninstall

To remove all PM2 services:

```bash
npx pm2 delete all
npx pm2 save
npx pm2 unstartup  # Remove startup script
```

To completely remove PM2:

```bash
npm uninstall -g pm2
rm -rf ~/.pm2
```

## Advanced: PM2 Plus

For production monitoring, consider [PM2 Plus](https://pm2.io/plus/):

- Real-time metrics and monitoring
- Error tracking and alerting
- Performance insights
- Remote management

Sign up and link:

```bash
npx pm2 link <secret> <public>
```

Free tier includes basic monitoring for hobby projects.

## Next Steps

- Read [WATCHDOG.md](WATCHDOG.md) to understand failure monitoring
- Check [SERVICE-STATUS.md](SERVICE-STATUS.md) for health checks
- Explore [PM2 docs](https://pm2.keymetrics.io/docs/usage/quick-start/) for advanced features
