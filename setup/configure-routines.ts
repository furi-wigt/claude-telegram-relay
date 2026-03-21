#!/usr/bin/env bun

/**
 * Configure Proactive Routines via PM2
 *
 * Registers all routine scripts as PM2 cron jobs.
 * Each routine runs on its own schedule and sends messages
 * to the appropriate agent group.
 *
 * Usage:
 *   bun run setup/configure-routines.ts                # Configure all routines
 *   bun run setup/configure-routines.ts --list          # List available routines
 *   bun run setup/configure-routines.ts --only morning  # Configure one routine
 *
 * Run manually: bun run setup:routines
 */

import { existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

const PROJECT_ROOT = dirname(import.meta.dir);
const HOME = homedir();
const LOGS_DIR = join(PROJECT_ROOT, "logs");

// Colors
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

interface Routine {
  name: string;
  script: string;
  cron: string;
  description: string;
  targetGroup: string;
}

const ROUTINES: Routine[] = [
  {
    name: "morning-summary",
    script: "routines/morning-summary.ts",
    cron: "0 7 * * *",
    description: "General morning overview",
    targetGroup: "GENERAL",
  },
  {
    name: "aws-daily-cost",
    script: "routines/aws-daily-cost.ts",
    cron: "0 9 * * *",
    description: "AWS cost analysis and anomaly detection",
    targetGroup: "AWS_ARCHITECT",
  },
  {
    name: "security-daily-scan",
    script: "routines/security-daily-scan.ts",
    cron: "0 8 * * *",
    description: "Security findings triage and compliance check",
    targetGroup: "SECURITY",
  },
];

async function findBun(): Promise<string> {
  const candidates = [
    join(HOME, ".bun", "bin", "bun"),
    "/usr/local/bin/bun",
    "/opt/homebrew/bin/bun",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  const proc = Bun.spawn(["which", "bun"], { stdout: "pipe" });
  const out = await new Response(proc.stdout).text();
  return out.trim() || "bun";
}

async function checkPM2(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["npx", "pm2", "-v"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

async function configureRoutine(routine: Routine, bunPath: string): Promise<boolean> {
  const scriptPath = join(PROJECT_ROOT, routine.script);

  if (!existsSync(scriptPath)) {
    console.log(`  ${red("x")} ${routine.name}: script not found at ${routine.script}`);
    return false;
  }

  // Delete existing PM2 process if any (ignore errors)
  try {
    await Bun.spawn(["npx", "pm2", "delete", routine.name], {
      stdout: "pipe",
      stderr: "pipe",
    }).exited;
  } catch {
    // Process might not exist
  }

  const proc = Bun.spawn(
    [
      "npx",
      "pm2",
      "start",
      scriptPath,
      "--name",
      routine.name,
      "--cron",
      routine.cron,
      "--no-autorestart",
      "--interpreter",
      bunPath,
      "--log",
      join(LOGS_DIR, `${routine.name}.log`),
      "--error",
      join(LOGS_DIR, `${routine.name}.error.log`),
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_ROOT,
    }
  );

  const exitCode = await proc.exited;

  if (exitCode === 0) {
    console.log(
      `  ${green("+")} ${routine.name} ${dim(`(${routine.cron})`)} -> ${routine.targetGroup}`
    );
    return true;
  }

  const stderr = await new Response(proc.stderr).text();
  console.log(`  ${red("x")} ${routine.name}: ${stderr.trim()}`);
  return false;
}

async function main() {
  const args = process.argv.slice(2);

  // --list flag
  if (args.includes("--list")) {
    console.log("");
    console.log(bold("  Available Routines:"));
    console.log("");
    for (const r of ROUTINES) {
      console.log(`    ${r.name}`);
      console.log(`      ${dim(r.description)}`);
      console.log(`      Schedule: ${r.cron}  Target: ${r.targetGroup}`);
      console.log("");
    }
    return;
  }

  console.log("");
  console.log(bold("  Configure Proactive Routines"));
  console.log("");

  // Ensure logs directory
  if (!existsSync(LOGS_DIR)) {
    mkdirSync(LOGS_DIR, { recursive: true });
  }

  // Check PM2
  if (!(await checkPM2())) {
    console.log(`  ${red("x")} PM2 not found. Install with: npm install -g pm2`);
    process.exit(1);
  }

  const bunPath = await findBun();
  console.log(dim(`  Bun: ${bunPath}`));
  console.log(dim(`  Project: ${PROJECT_ROOT}`));
  console.log("");

  // --only flag to configure a single routine
  const onlyIdx = args.indexOf("--only");
  const onlyName = onlyIdx !== -1 ? args[onlyIdx + 1] : null;

  const routinesToConfigure = onlyName
    ? ROUTINES.filter((r) => r.name === onlyName)
    : ROUTINES;

  if (onlyName && routinesToConfigure.length === 0) {
    console.log(`  ${red("x")} Unknown routine: ${onlyName}`);
    console.log(`      Available: ${ROUTINES.map((r) => r.name).join(", ")}`);
    process.exit(1);
  }

  // Configure each routine
  let successCount = 0;
  for (const routine of routinesToConfigure) {
    const ok = await configureRoutine(routine, bunPath);
    if (ok) successCount++;
  }

  // Save PM2 state
  await Bun.spawn(["npx", "pm2", "save"], {
    stdout: "pipe",
    stderr: "pipe",
  }).exited;

  console.log("");
  console.log(
    `  ${successCount}/${routinesToConfigure.length} routines configured`
  );

  if (successCount > 0) {
    console.log("");
    console.log(dim("  Commands:"));
    console.log(dim("    npx pm2 list                    # View all jobs"));
    console.log(dim("    npx pm2 logs morning-summary    # View routine logs"));
    console.log(dim("    npx pm2 trigger morning-summary # Run now (manual)"));
    console.log(dim("    npx pm2 delete morning-summary  # Remove a routine"));
  }

  console.log("");
}

main().catch((err) => {
  console.error(`\n  ${red("Error:")} ${err.message}`);
  process.exit(1);
});
