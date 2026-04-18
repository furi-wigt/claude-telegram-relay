import { join } from "path";
import { homedir } from "os";
import { readFileSync, existsSync } from "fs";
import { writeFile, mkdir } from "fs/promises";

export const USER_ROUTINE_CONFIG_PATH = join(homedir(), ".claude-relay/routines.config.json");

export interface RoutineConfig {
  name: string;
  type: "prompt" | "handler";
  schedule: string;
  group: string;
  topicId?: number;
  enabled: boolean;
  params?: Record<string, unknown>;
  prompt?: string;
  model?: string;
  handler?: string;
  priority?: "urgent" | "normal" | "background";
}

/** Load and merge repo defaults with user overrides. User entries win on same `name`. */
export function loadRoutineConfigs(): RoutineConfig[] {
  const repoPath = join(import.meta.dir, "../../config/routines.config.json");
  const userPath = join(homedir(), ".claude-relay/routines.config.json");

  const repoConfigs: RoutineConfig[] = existsSync(repoPath)
    ? (JSON.parse(readFileSync(repoPath, "utf-8")) as RoutineConfig[])
    : [];

  const userConfigs: RoutineConfig[] = existsSync(userPath)
    ? (JSON.parse(readFileSync(userPath, "utf-8")) as RoutineConfig[])
    : [];

  // Deep merge: user entries override by name; user can add new entries
  const merged = new Map<string, RoutineConfig>();
  for (const c of repoConfigs) merged.set(c.name, c);
  for (const c of userConfigs) {
    const existing = merged.get(c.name);
    merged.set(c.name, existing ? { ...existing, ...c } : c);
  }

  return Array.from(merged.values());
}

/** Write (replace) user routines config. Scheduler hot-reloads via fs.watch automatically. */
export async function saveUserRoutineConfigs(configs: RoutineConfig[]): Promise<void> {
  await mkdir(join(homedir(), ".claude-relay"), { recursive: true });
  await writeFile(USER_ROUTINE_CONFIG_PATH, JSON.stringify(configs, null, 2) + "\n", "utf-8");
}

let _cache: RoutineConfig[] | null = null;

export function getRoutineConfig(name: string): RoutineConfig | undefined {
  if (!_cache) _cache = loadRoutineConfigs();
  return _cache.find((c) => c.name === name);
}
