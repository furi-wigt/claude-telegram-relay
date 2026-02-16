# Proactive Routines Guide for Multi-Agent Architecture

**Architecture**: Smart routing per routine type with agent persona usage

**User Decisions**:
- ✅ Different routine types route to different groups
- ✅ Routine messages use the specialized agent's voice/perspective
- ✅ Each routine specifies target group(s)

---

## Architecture Overview

### How Routines Work

```
Scheduled Task (cron/PM2)
   ↓
Routine Script gathers data
   ↓
Determines target group(s)
   ↓
Sends message to group chat_id
   ↓
Bot receives message (from script, not user)
   ↓
Routes to appropriate agent based on chat_id
   ↓
Agent processes with full persona and context
   ↓
Responds in agent's specialized voice
```

### Key Components

1. **Routine Scripts** (`routines/*.ts`) - Scheduled tasks that gather data and send messages
2. **Group Mapping** (`src/routing/groupRouter.ts`) - Maps chat_id to agent
3. **Message Sender** (`src/utils/sendToGroup.ts`) - Helper to send messages to specific groups
4. **Agent Context** - Each routine message gets processed by the target group's agent

---

## Routine Types and Target Groups

### Global Routines (→ General Group)

**Morning Summary**
- **Schedule**: 7:00 AM daily
- **Target**: General AI Assistant group
- **Data Sources**: Calendar, tasks, weather, news
- **Agent Persona**: General assistant summarizes your day ahead

**Evening Recap**
- **Schedule**: 8:00 PM daily
- **Target**: General AI Assistant group
- **Data Sources**: Completed tasks, unread messages, tomorrow's calendar
- **Agent Persona**: General assistant reviews your day and prepares for tomorrow

**Smart Check-in**
- **Schedule**: Variable (context-aware)
- **Target**: General AI Assistant group
- **Data Sources**: Your activity, calendar, goals
- **Agent Persona**: General assistant proactively reaches out when relevant

---

### AWS-Specific Routines (→ AWS Cloud Architect Group)

**Daily Cost Alert**
- **Schedule**: 9:00 AM daily
- **Target**: AWS Cloud Architect group
- **Data Sources**: AWS Cost Explorer API
- **Agent Persona**: AWS Architect analyzes costs, flags anomalies, suggests optimizations

**Weekly Infrastructure Review**
- **Schedule**: Monday 10:00 AM
- **Target**: AWS Cloud Architect group
- **Data Sources**: AWS CloudWatch, Trusted Advisor
- **Agent Persona**: AWS Architect summarizes health metrics, recommends improvements

**Lambda Cold Start Alert**
- **Schedule**: Real-time (triggered by CloudWatch alarm)
- **Target**: AWS Cloud Architect group
- **Data Sources**: CloudWatch Logs
- **Agent Persona**: AWS Architect suggests warm-up strategies or provisioned concurrency

---

### Security-Specific Routines (→ Security & Compliance Group)

**Daily Security Scan Summary**
- **Schedule**: 8:00 AM daily
- **Target**: Security & Compliance group
- **Data Sources**: AWS Security Hub, GuardDuty
- **Agent Persona**: Security Analyst triages findings, prioritizes by severity

**Weekly Compliance Report**
- **Schedule**: Friday 4:00 PM
- **Target**: Security & Compliance group
- **Data Sources**: AWS Config, compliance scanning tools
- **Agent Persona**: Security Analyst generates PDPA/AIAS compliance summary

**Certificate Expiry Warning**
- **Schedule**: Daily check, alert when <30 days
- **Target**: Security & Compliance group
- **Data Sources**: AWS Certificate Manager
- **Agent Persona**: Security Analyst identifies expiring certs, provides renewal steps

---

### Code Quality Routines (→ Code Quality & TDD Group)

**PR Review Reminder**
- **Schedule**: 2:00 PM daily
- **Target**: Code Quality & TDD group
- **Data Sources**: GitHub API (open PRs)
- **Agent Persona**: Code Quality Coach reminds about pending reviews, highlights stale PRs

**Test Coverage Report**
- **Schedule**: After CI runs (webhook-triggered)
- **Target**: Code Quality & TDD group
- **Data Sources**: Coverage reports from CI
- **Agent Persona**: Code Quality Coach analyzes coverage trends, suggests test improvements

**Weekly Code Health Summary**
- **Schedule**: Friday 3:00 PM
- **Target**: Code Quality & TDD group
- **Data Sources**: SonarQube, code metrics
- **Agent Persona**: Code Quality Coach reviews technical debt, prioritizes refactoring

---

### Documentation Routines (→ Technical Documentation Group)

**Undocumented Changes Alert**
- **Schedule**: After each PR merge (webhook-triggered)
- **Target**: Technical Documentation group
- **Data Sources**: GitHub PR metadata
- **Agent Persona**: Documentation Specialist identifies changes needing docs, suggests ADR creation

**Weekly ADR Summary**
- **Schedule**: Friday 5:00 PM
- **Target**: Technical Documentation group
- **Data Sources**: Recent ADRs, architecture changes
- **Agent Persona**: Documentation Specialist summarizes decisions made this week

---

## Implementation

### Step 1: Create Message Sender Utility

**File**: `src/utils/sendToGroup.ts`

```typescript
import { Bot } from "grammy";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const bot = new Bot(BOT_TOKEN);

/**
 * Send a message to a specific Telegram group
 * The bot will process this as if it came from a user
 * and route to the appropriate agent based on chat_id
 */
export async function sendToGroup(
  chatId: number,
  message: string
): Promise<void> {
  try {
    await bot.api.sendMessage(chatId, message);
    console.log(`✓ Sent routine message to chat ${chatId}`);
  } catch (error) {
    console.error(`✗ Failed to send to chat ${chatId}:`, error);
    throw error;
  }
}

/**
 * Send a message with typing indicator (more natural)
 */
export async function sendToGroupWithTyping(
  chatId: number,
  message: string,
  typingDuration: number = 2000
): Promise<void> {
  try {
    // Send typing indicator
    await bot.api.sendChatAction(chatId, "typing");

    // Wait for typing duration
    await new Promise(resolve => setTimeout(resolve, typingDuration));

    // Send message
    await bot.api.sendMessage(chatId, message);
    console.log(`✓ Sent routine message to chat ${chatId}`);
  } catch (error) {
    console.error(`✗ Failed to send to chat ${chatId}:`, error);
    throw error;
  }
}
```

**Actions**:
- [ ] Create `src/utils/sendToGroup.ts`

---

### Step 2: Create Group ID Registry

**File**: `src/config/groups.ts`

```typescript
/**
 * Central registry of group chat IDs
 * Populated from .env or auto-discovered at runtime
 */
export const GROUPS = {
  AWS_ARCHITECT: parseInt(process.env.GROUP_AWS_CHAT_ID || "0"),
  SECURITY: parseInt(process.env.GROUP_SECURITY_CHAT_ID || "0"),
  DOCUMENTATION: parseInt(process.env.GROUP_DOCS_CHAT_ID || "0"),
  CODE_QUALITY: parseInt(process.env.GROUP_CODE_CHAT_ID || "0"),
  GENERAL: parseInt(process.env.GROUP_GENERAL_CHAT_ID || "0")
};

/**
 * Validate that all groups are configured
 */
export function validateGroups(): boolean {
  const missing = Object.entries(GROUPS)
    .filter(([_, id]) => id === 0)
    .map(([name, _]) => name);

  if (missing.length > 0) {
    console.warn(`⚠ Missing group IDs: ${missing.join(", ")}`);
    console.warn("Routines may fail until groups are configured in .env");
    return false;
  }

  console.log("✓ All group IDs configured");
  return true;
}
```

**Actions**:
- [ ] Create `src/config/groups.ts`

---

### Step 3: Example Routine - AWS Daily Cost Alert

**File**: `routines/aws-daily-cost.ts`

```typescript
#!/usr/bin/env bun

/**
 * AWS Daily Cost Alert
 * Runs every morning, sends cost summary to AWS Architect group
 * Agent processes with AWS expertise and cost optimization perspective
 */

import { sendToGroup } from "../src/utils/sendToGroup.ts";
import { GROUPS, validateGroups } from "../src/config/groups.ts";

async function getAWSCostData(): Promise<{
  yesterday: number;
  weekAverage: number;
  monthToDate: number;
  topServices: Array<{ service: string; cost: number }>;
}> {
  // TODO: Integrate with AWS Cost Explorer API
  // For now, mock data
  return {
    yesterday: 127.45,
    weekAverage: 132.18,
    monthToDate: 2834.92,
    topServices: [
      { service: "EC2", cost: 45.23 },
      { service: "RDS", cost: 38.91 },
      { service: "Lambda", cost: 22.15 },
      { service: "S3", cost: 12.08 },
      { service: "CloudFront", cost: 9.08 }
    ]
  };
}

async function main() {
  console.log("Running AWS Daily Cost Alert...");

  // Validate groups configured
  if (!validateGroups()) {
    console.error("Cannot run routine - groups not configured");
    process.exit(1);
  }

  // Gather cost data
  const costData = await getAWSCostData();

  // Format message for AWS Architect agent
  const message = `Daily AWS Cost Report

Yesterday's spend: $${costData.yesterday.toFixed(2)}
7-day average: $${costData.weekAverage.toFixed(2)}
Month-to-date: $${costData.monthToDate.toFixed(2)}

Top 5 services:
${costData.topServices.map((s, i) =>
  `${i + 1}. ${s.service}: $${s.cost.toFixed(2)}`
).join('\n')}

Please analyze for anomalies and suggest cost optimizations.`;

  // Send to AWS Architect group
  // Agent will process with AWS expertise
  await sendToGroup(GROUPS.AWS_ARCHITECT, message);

  console.log("✓ AWS cost alert sent");
}

main().catch((error) => {
  console.error("Error running AWS cost routine:", error);
  process.exit(1);
});
```

**Actions**:
- [ ] Create `routines/aws-daily-cost.ts`
- [ ] Add AWS Cost Explorer integration (or mock for testing)

---

### Step 4: Example Routine - Security Daily Scan

**File**: `routines/security-daily-scan.ts`

```typescript
#!/usr/bin/env bun

/**
 * Security Daily Scan Summary
 * Runs every morning, sends security findings to Security group
 * Agent processes with security expertise and compliance focus
 */

import { sendToGroup } from "../src/utils/sendToGroup.ts";
import { GROUPS, validateGroups } from "../src/config/groups.ts";

async function getSecurityFindings(): Promise<{
  critical: number;
  high: number;
  medium: number;
  low: number;
  newFindings: Array<{ severity: string; title: string }>;
  complianceStatus: { pdpa: boolean; aias: boolean };
}> {
  // TODO: Integrate with AWS Security Hub API
  return {
    critical: 0,
    high: 2,
    medium: 7,
    low: 15,
    newFindings: [
      { severity: "HIGH", title: "S3 bucket with public read access" },
      { severity: "HIGH", title: "IAM user with overly permissive policy" }
    ],
    complianceStatus: {
      pdpa: true,
      aias: false  // Flagged for review
    }
  };
}

async function main() {
  console.log("Running Security Daily Scan...");

  if (!validateGroups()) {
    console.error("Cannot run routine - groups not configured");
    process.exit(1);
  }

  const findings = await getSecurityFindings();

  const message = `Daily Security Scan Report

Findings by Severity:
🔴 Critical: ${findings.critical}
🟠 High: ${findings.high}
🟡 Medium: ${findings.medium}
⚪ Low: ${findings.low}

New findings since yesterday:
${findings.newFindings.map(f =>
  `${f.severity === 'CRITICAL' ? '🔴' : '🟠'} ${f.title}`
).join('\n')}

Compliance Status:
${findings.complianceStatus.pdpa ? '✅' : '❌'} PDPA Compliant
${findings.complianceStatus.aias ? '✅' : '❌'} AIAS Compliant

Please triage these findings and recommend remediation steps.`;

  await sendToGroup(GROUPS.SECURITY, message);

  console.log("✓ Security scan summary sent");
}

main().catch((error) => {
  console.error("Error running security routine:", error);
  process.exit(1);
});
```

**Actions**:
- [ ] Create `routines/security-daily-scan.ts`
- [ ] Add AWS Security Hub integration

---

### Step 5: Example Routine - General Morning Summary

**File**: `routines/morning-summary.ts` (update existing)

```typescript
#!/usr/bin/env bun

/**
 * Morning Summary
 * Sends to General AI Assistant group
 * Agent provides holistic daily overview
 */

import { sendToGroup } from "../src/utils/sendToGroup.ts";
import { GROUPS, validateGroups } from "../src/config/groups.ts";

async function getDailySummaryData(): Promise<{
  date: string;
  weather: string;
  calendarEvents: number;
  pendingTasks: number;
  unreadMessages: number;
}> {
  // TODO: Integrate with actual APIs (calendar, tasks, weather)
  return {
    date: new Date().toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric"
    }),
    weather: "Partly cloudy, 28°C",
    calendarEvents: 3,
    pendingTasks: 7,
    unreadMessages: 12
  };
}

async function main() {
  console.log("Running Morning Summary...");

  if (!validateGroups()) {
    console.error("Cannot run routine - groups not configured");
    process.exit(1);
  }

  const data = await getDailySummaryData();

  const message = `Good morning! Here's your daily overview:

📅 ${data.date}
🌤️ ${data.weather}

Today you have:
• ${data.calendarEvents} calendar events
• ${data.pendingTasks} pending tasks
• ${data.unreadMessages} unread messages

Please provide a brief summary and suggest priorities for today.`;

  await sendToGroup(GROUPS.GENERAL, message);

  console.log("✓ Morning summary sent");
}

main().catch((error) => {
  console.error("Error running morning summary:", error);
  process.exit(1);
});
```

**Actions**:
- [ ] Update existing `examples/morning-briefing.ts` or create new `routines/morning-summary.ts`
- [ ] Add calendar/tasks integration

---

### Step 6: Routine Scheduler Configuration

**File**: `setup/configure-routines.ts`

```typescript
#!/usr/bin/env bun

/**
 * Configure all proactive routines via PM2
 */

import { spawn } from "bun";
import { join } from "path";

const PROJECT_ROOT = process.cwd();

interface Routine {
  name: string;
  script: string;
  cron: string;
  description: string;
}

const ROUTINES: Routine[] = [
  {
    name: "morning-summary",
    script: "routines/morning-summary.ts",
    cron: "0 7 * * *",  // 7:00 AM daily
    description: "General morning overview"
  },
  {
    name: "aws-daily-cost",
    script: "routines/aws-daily-cost.ts",
    cron: "0 9 * * *",  // 9:00 AM daily
    description: "AWS cost analysis"
  },
  {
    name: "security-daily-scan",
    script: "routines/security-daily-scan.ts",
    cron: "0 8 * * *",  // 8:00 AM daily
    description: "Security findings summary"
  },
  {
    name: "code-pr-reminder",
    script: "routines/code-pr-reminder.ts",
    cron: "0 14 * * 1-5",  // 2:00 PM weekdays
    description: "PR review reminder"
  },
  {
    name: "evening-recap",
    script: "routines/evening-recap.ts",
    cron: "0 20 * * *",  // 8:00 PM daily
    description: "Evening recap and tomorrow prep"
  }
];

async function configureRoutine(routine: Routine): Promise<void> {
  console.log(`Configuring routine: ${routine.name}`);

  const scriptPath = join(PROJECT_ROOT, routine.script);

  const proc = spawn([
    "npx",
    "pm2",
    "start",
    scriptPath,
    "--name", routine.name,
    "--cron", routine.cron,
    "--no-autorestart",
    "--interpreter", "bun"
  ]);

  const exitCode = await proc.exited;

  if (exitCode === 0) {
    console.log(`✓ Configured: ${routine.name} (${routine.description})`);
  } else {
    console.error(`✗ Failed to configure: ${routine.name}`);
  }
}

async function main() {
  console.log("Configuring proactive routines...\n");

  for (const routine of ROUTINES) {
    await configureRoutine(routine);
  }

  console.log("\nAll routines configured!");
  console.log("View status: npx pm2 list");
  console.log("View logs: npx pm2 logs");
}

main();
```

**Actions**:
- [ ] Create `setup/configure-routines.ts`
- [ ] Add to package.json: `"setup:routines": "bun run setup/configure-routines.ts"`

---

## How Agent Personas Work in Routines

When a routine sends a message to a group:

1. **Message arrives** at group chat_id
2. **Bot detects** it's from the routine script (not user)
3. **Router maps** chat_id → agent config
4. **Agent loads** specialized system prompt + memory for that group
5. **Agent processes** the routine's data request with its expertise
6. **Response uses** the agent's voice and perspective

### Example Flow: AWS Cost Alert

```
Routine script sends:
"Yesterday's AWS spend: $127.45. Top service: EC2 at $45.23.
Please analyze for anomalies and suggest cost optimizations."

   ↓ (sent to AWS Architect group, chat_id: 123)

Agent receives with context:
- System prompt: "You are an AWS Cloud Architect..."
- Group memory: Previous cost discussions, optimization history
- User profile: Government sector, cost-conscious

Agent responds in AWS Architect voice:
"Your EC2 costs are 15% above baseline. I notice 3 t3.medium instances
running 24/7 with <10% CPU utilization. Recommendations:
1. Right-size to t3.small (saves $12/day)
2. Enable auto-scaling for web tier
3. Consider Savings Plans for predictable workloads (20% discount)

Would you like me to draft an infrastructure optimization ADR?"
```

The agent's **specialized knowledge and perspective** transforms raw data into **actionable insights**.

---

## Adding New Routines

### Template for New Routine

```typescript
#!/usr/bin/env bun

import { sendToGroup } from "../src/utils/sendToGroup.ts";
import { GROUPS, validateGroups } from "../src/config/groups.ts";

async function gatherData(): Promise<any> {
  // Fetch data from APIs, databases, etc.
  return {};
}

async function main() {
  console.log("Running [ROUTINE_NAME]...");

  if (!validateGroups()) {
    console.error("Cannot run routine - groups not configured");
    process.exit(1);
  }

  const data = await gatherData();

  const message = `[Formatted message for agent]

[Data summary]

[Question or instruction for agent]`;

  // Choose target group based on routine type
  await sendToGroup(GROUPS.[TARGET_GROUP], message);

  console.log("✓ [ROUTINE_NAME] complete");
}

main().catch((error) => {
  console.error("Error running [ROUTINE_NAME]:", error);
  process.exit(1);
});
```

### Steps to Add:

1. Create script in `routines/[name].ts`
2. Choose target group (AWS, Security, Docs, Code, General)
3. Format message to leverage agent's expertise
4. Add to `setup/configure-routines.ts`
5. Configure schedule (cron expression)
6. Test manually: `bun run routines/[name].ts`
7. Deploy: `bun run setup:routines`

---

## Testing Routines

### Manual Test

```bash
# Test AWS cost routine
bun run routines/aws-daily-cost.ts

# Check AWS Architect group for message
# Verify agent responds with cost analysis
```

### Scheduled Test

```bash
# Configure routines
bun run setup:routines

# View scheduled jobs
npx pm2 list

# Trigger manually (don't wait for cron)
npx pm2 trigger morning-summary

# View logs
npx pm2 logs morning-summary
```

---

## Future Routine Ideas

### AWS Group
- Hourly CloudWatch alarm digest
- Weekly Trusted Advisor recommendations
- Monthly infrastructure health report
- Real-time: Lambda error spike alerts

### Security Group
- Bi-weekly vulnerability scan summary
- Monthly compliance audit report
- Real-time: Suspicious activity alerts
- Certificate expiry warnings (30/7 days)

### Documentation Group
- Weekly: Undocumented PRs summary
- After each release: Changelog generation
- Monthly: Architecture drift detection
- Stale docs reminder

### Code Quality Group
- Daily: Test coverage trends
- Weekly: Technical debt report
- After CI: Failed test analysis
- Monthly: Code health metrics

### General Group
- Morning: Daily briefing
- Evening: Day recap + tomorrow prep
- Weekly: Goal progress review
- Smart check-ins (context-aware)

---

## Best Practices

1. **Keep messages concise** - Agents will expand with analysis
2. **Ask specific questions** - "Analyze for anomalies" triggers deeper thinking
3. **Provide context** - Baselines, trends, historical data
4. **Use agent's vocabulary** - "Cost optimization" for AWS, "threat modeling" for Security
5. **Schedule wisely** - Avoid overwhelming with too many routines
6. **Monitor logs** - Use PM2 to track routine execution
7. **Fail gracefully** - Handle API errors, continue on failures

---

## Summary

**Routine Architecture**:
- ✅ Smart routing: Different routines → different groups
- ✅ Agent personas: Each group's agent processes with specialized expertise
- ✅ Isolated context: Routines leverage each group's isolated memory
- ✅ Scalable: Easy to add new routines by creating new scripts

**Next Steps**:
1. Implement base utilities (`sendToGroup`, `groups.ts`)
2. Create 2-3 example routines (morning summary, AWS cost, security scan)
3. Configure PM2 scheduling
4. Test each routine manually
5. Add more routines as needed

This architecture turns static scheduled messages into **intelligent, context-aware insights** from your specialized AI agents!
