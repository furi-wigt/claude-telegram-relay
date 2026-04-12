import type { Job, InterventionType, JobSource } from "./types.ts";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface AutoApproveRule {
  executor?: string;
  source?: JobSource;
  intervention_types: InterventionType[];
  action: "confirm" | "skip" | "abort";
  condition?: string; // e.g. "confidence_gte:0.9" — reserved for future use
}

export class AutoApproveEngine {
  constructor(private rules: AutoApproveRule[]) {}

  /**
   * Evaluate a job against auto-approve rules.
   * Returns the action if a rule matches, null otherwise.
   */
  evaluate(job: Job): "confirm" | "skip" | "abort" | null {
    if (!job.intervention_type) return null;

    for (const rule of this.rules) {
      if (rule.executor && rule.executor !== job.executor) continue;
      if (rule.source && rule.source !== job.source) continue;
      if (!rule.intervention_types.includes(job.intervention_type)) continue;
      return rule.action;
    }

    return null;
  }

  /**
   * Reload rules from the config file.
   * Returns a new AutoApproveEngine with the loaded rules.
   */
  static loadFromFile(): AutoApproveEngine {
    const configPath = join(
      process.env.RELAY_USER_DIR || join(homedir(), ".claude-relay"),
      "auto-approve.json"
    );

    if (!existsSync(configPath)) {
      return new AutoApproveEngine([]);
    }

    try {
      const raw = readFileSync(configPath, "utf-8");
      const rules = JSON.parse(raw) as AutoApproveRule[];
      console.log(`[jobs:auto-approve] loaded ${rules.length} rules from ${configPath}`);
      return new AutoApproveEngine(rules);
    } catch (err) {
      console.warn(`[jobs:auto-approve] failed to load ${configPath}:`, err);
      return new AutoApproveEngine([]);
    }
  }
}
