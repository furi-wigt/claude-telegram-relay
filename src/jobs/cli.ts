// src/jobs/cli.ts
/**
 * Job Queue CLI — relay jobs <command>
 *
 * Usage:
 *   bun run relay:jobs                          # list active + recent jobs
 *   bun run relay:jobs --status pending         # filter by status
 *   bun run relay:jobs --type routine           # filter by type
 *   bun run relay:jobs --intervention           # only awaiting-intervention
 *   bun run relay:jobs <id>                     # job detail
 *   bun run relay:jobs approve <id>             # resolve → confirmed
 *   bun run relay:jobs answer <id> "text"       # resolve clarification
 *   bun run relay:jobs abort <id>               # cancel
 *   bun run relay:jobs retry <id>               # re-queue failed job
 *   bun run relay:jobs cancel <id>              # cancel pending job
 *   bun run relay:jobs run "<prompt>"                       # submit claude-session job
 *   bun run relay:jobs run --type routine --executor <name> # submit routine job (title = executor name)
 */

import { loadEnv } from "../config/envLoader.ts";
import { getDb } from "../local/db.ts";
import { JobStore } from "./jobStore.ts";
import { createSubmitJob } from "./submitJob.ts";
import type { Job, JobStatus, JobType } from "./types.ts";

loadEnv();

const STATUS_EMOJI: Record<string, string> = {
  pending: "⏳",
  running: "▶️",
  done: "✅",
  failed: "❌",
  cancelled: "🚫",
  paused: "⏸️",
  preempted: "⏪",
  "awaiting-intervention": "⚠️",
};

function formatAge(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function printTable(jobs: Job[]): void {
  if (jobs.length === 0) {
    console.log("No jobs found.");
    return;
  }

  const header = `${"STATUS".padEnd(25)} ${"TITLE".padEnd(30)} ${"TYPE".padEnd(14)} ${"AGE".padEnd(10)} ID`;
  console.log(header);
  console.log("─".repeat(header.length));

  for (const job of jobs) {
    const emoji = STATUS_EMOJI[job.status] ?? "?";
    const status = `${emoji} ${job.status}`.padEnd(25);
    const title = job.title.slice(0, 28).padEnd(30);
    const type = job.type.padEnd(14);
    const age = formatAge(job.created_at).padEnd(10);
    const id = job.id.slice(0, 8);
    console.log(`${status} ${title} ${type} ${age} ${id}`);
  }
}

function printDetail(job: Job): void {
  console.log(`\nJob: ${job.title}`);
  console.log(`ID:       ${job.id}`);
  console.log(`Status:   ${STATUS_EMOJI[job.status] ?? ""} ${job.status}`);
  console.log(`Type:     ${job.type}`);
  console.log(`Executor: ${job.executor}`);
  console.log(`Priority: ${job.priority}`);
  console.log(`Source:   ${job.source}`);
  console.log(`Created:  ${job.created_at}`);
  if (job.started_at) console.log(`Started:  ${job.started_at}`);
  if (job.completed_at) console.log(`Done:     ${job.completed_at}`);
  if (job.error) console.log(`Error:    ${job.error}`);
  if (job.intervention_type) {
    console.log(`\nIntervention: ${job.intervention_type}`);
    console.log(`Prompt:   ${job.intervention_prompt}`);
    if (job.auto_resolve_policy) console.log(`Policy:   ${job.auto_resolve_policy}`);
  }
  if (job.dedup_key) console.log(`Dedup:    ${job.dedup_key}`);
  console.log(`Retries:  ${job.retry_count}`);
  if (job.payload && Object.keys(job.payload).length > 0) {
    console.log(`Payload:  ${JSON.stringify(job.payload, null, 2)}`);
  }
}

function findJobByPrefix(store: JobStore, prefix?: string): string | null {
  if (!prefix) {
    console.error("Job ID required");
    process.exit(1);
    return null;
  }

  // Try exact match first
  const exact = store.getJob(prefix);
  if (exact) return exact.id;

  // Try prefix match
  const all = store.listJobs({ limit: 100 });
  const matches = all.filter((j) => j.id.startsWith(prefix));
  if (matches.length === 1) return matches[0].id;
  if (matches.length === 0) {
    console.error(`No job found matching "${prefix}"`);
    process.exit(1);
    return null;
  }
  console.error(`Ambiguous prefix "${prefix}" — matches ${matches.length} jobs`);
  process.exit(1);
  return null;
}

function main() {
  const args = process.argv.slice(2);
  const db = getDb();
  const store = new JobStore(db);

  const isJson = args.includes("--json");
  const filteredArgs = args.filter((a) => a !== "--json");

  const command = filteredArgs[0] ?? "";

  // relay jobs approve <id>
  if (command === "approve") {
    const id = findJobByPrefix(store, filteredArgs[1]);
    if (!id) return;
    store.clearIntervention(id, "running");
    store.insertCheckpoint(id, 0, { resolution: "confirmed", via: "cli" });
    console.log(`✅ Approved: ${id.slice(0, 8)}`);
    return;
  }

  // relay jobs abort <id>
  if (command === "abort") {
    const id = findJobByPrefix(store, filteredArgs[1]);
    if (!id) return;
    store.clearIntervention(id, "cancelled");
    console.log(`🚫 Aborted: ${id.slice(0, 8)}`);
    return;
  }

  // relay jobs answer <id> "text"
  if (command === "answer") {
    const id = findJobByPrefix(store, filteredArgs[1]);
    if (!id) return;
    const answer = filteredArgs.slice(2).join(" ");
    if (!answer) {
      console.error("Usage: relay jobs answer <id> <answer text>");
      process.exit(1);
    }
    store.insertCheckpoint(id, 0, { resolution: "answered", answer, via: "cli" });
    store.clearIntervention(id, "running");
    console.log(`✏️ Answered: ${id.slice(0, 8)}`);
    return;
  }

  // relay jobs retry <id>
  if (command === "retry") {
    const id = findJobByPrefix(store, filteredArgs[1]);
    if (!id) return;
    const job = store.getJob(id)!;
    if (job.status !== "failed") {
      console.error(`Job ${id.slice(0, 8)} is ${job.status}, not failed`);
      process.exit(1);
    }
    store.updateStatus(id, "pending");
    console.log(`🔄 Re-queued: ${id.slice(0, 8)}`);
    return;
  }

  // relay jobs cancel <id>
  if (command === "cancel") {
    const id = findJobByPrefix(store, filteredArgs[1]);
    if (!id) return;
    store.updateStatus(id, "cancelled");
    console.log(`🚫 Cancelled: ${id.slice(0, 8)}`);
    return;
  }

  // relay jobs run "<title/prompt>" [--type X] [--executor Y] [--priority Z]
  // relay jobs run --type routine --executor <name>   (title defaults to executor name)
  if (command === "run") {
    const submitJob = createSubmitJob(store, () => {});
    const typeIdx = filteredArgs.indexOf("--type");
    const execIdx = filteredArgs.indexOf("--executor");
    const prioIdx = filteredArgs.indexOf("--priority");

    const type = (typeIdx >= 0 ? filteredArgs[typeIdx + 1] : "claude-session") as JobType;
    const executor = execIdx >= 0 ? filteredArgs[execIdx + 1] : type;
    const priority = prioIdx >= 0 ? filteredArgs[prioIdx + 1] : "normal";

    // First positional after "run" is the title/prompt — skip if it's a flag
    const firstArg = filteredArgs[1];
    const titleArg = firstArg && !firstArg.startsWith("--") ? firstArg : undefined;

    if (!titleArg && type === "claude-session") {
      console.error('Usage: relay jobs run "<prompt>" [--type TYPE] [--executor EXECUTOR]');
      process.exit(1);
    }

    const title = titleArg ?? executor;
    const payload: Record<string, unknown> =
      type === "claude-session" ? { prompt: titleArg } : { config: {} };

    const job = submitJob({
      type,
      executor,
      title: title.slice(0, 80),
      source: "cli",
      priority: priority as any,
      payload,
    });

    if (job) {
      if (isJson) {
        console.log(JSON.stringify(job, null, 2));
      } else {
        console.log(`✅ Submitted: ${job.id.slice(0, 8)} — ${job.title}`);
      }
    } else {
      console.error("Failed to submit job (duplicate dedup_key?)");
    }
    return;
  }

  // relay jobs --intervention
  if (args.includes("--intervention")) {
    const jobs = store.getAwaitingIntervention();
    if (isJson) {
      console.log(JSON.stringify(jobs, null, 2));
    } else {
      printTable(jobs);
    }
    return;
  }

  // relay jobs <id> — detail view
  if (command && !command.startsWith("-")) {
    const id = findJobByPrefix(store, command);
    if (!id) return;
    const job = store.getJob(id)!;
    if (isJson) {
      console.log(JSON.stringify(job, null, 2));
    } else {
      printDetail(job);
    }
    return;
  }

  // relay jobs [--status X] [--type Y] — list view
  const statusIdx = args.indexOf("--status");
  const typeIdx = args.indexOf("--type");
  const status = statusIdx >= 0 ? (args[statusIdx + 1] as JobStatus) : undefined;
  const type = typeIdx >= 0 ? (args[typeIdx + 1] as JobType) : undefined;

  const jobs = store.listJobs({ status, type, limit: 30 });
  if (isJson) {
    console.log(JSON.stringify(jobs, null, 2));
  } else {
    printTable(jobs);
  }
}

main();
