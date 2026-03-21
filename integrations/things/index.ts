/**
 * Things 3 Integration — task management for macOS.
 *
 * Write operations: URL scheme (always available, Things 3 must be running).
 * Read operations: clings CLI (optional — install: brew install dan-hart/tap/clings).
 *
 * Usage:
 *   import { createThingsClient } from 'integrations/things';
 *   const things = createThingsClient();  // always returns a client
 *
 *   await things.addTask({ title: 'Review ETF allocation', when: 'today' });
 *   if (things.canRead) {
 *     const tasks = await things.getTodayTasks();
 *   }
 */

import {
  addTaskViaURL,
  addTasksViaURL,
  completeTaskViaURL,
  updateTaskViaURL,
} from "./url-scheme.ts";
import {
  getTodayTasksRaw,
  getInboxTasksRaw,
  searchTasksRaw,
  isClingsAvailable,
  UnavailableError,
} from "./cli.ts";
import type { ThingsTask, NewThingsTask } from "./types.ts";

export type { ThingsTask, NewThingsTask };
export { UnavailableError };

export interface ThingsClient {
  // Write — always available via URL scheme
  addTask(task: NewThingsTask): Promise<{ id?: string }>;
  addTasks(tasks: NewThingsTask[]): Promise<void>;
  completeTask(id: string): Promise<void>;
  updateTask(id: string, updates: Partial<NewThingsTask>): Promise<void>;

  // Read — requires clings (may throw UnavailableError)
  getTodayTasks(): Promise<ThingsTask[]>;
  getInboxTasks(): Promise<ThingsTask[]>;
  searchTasks(query: string, tag?: string): Promise<ThingsTask[]>;

  readonly canRead: boolean;
}

/** Always returns a client — write operations work without config. */
export function createThingsClient(): ThingsClient {
  // canRead is resolved lazily on first read call
  let _canRead: boolean | undefined;

  async function ensureCanRead(): Promise<void> {
    if (_canRead === undefined) {
      _canRead = await isClingsAvailable();
    }
    if (!_canRead) {
      throw new UnavailableError(
        "clings is not installed. Install with: brew install dan-hart/tap/clings"
      );
    }
  }

  return {
    get canRead(): boolean {
      return _canRead ?? false;
    },

    async addTask(task) {
      await addTaskViaURL(task);
      return {};
    },

    async addTasks(tasks) {
      await addTasksViaURL(tasks);
    },

    async completeTask(id) {
      await completeTaskViaURL(id);
    },

    async updateTask(id, updates) {
      await updateTaskViaURL(id, updates);
    },

    async getTodayTasks() {
      await ensureCanRead();
      return getTodayTasksRaw();
    },

    async getInboxTasks() {
      await ensureCanRead();
      return getInboxTasksRaw();
    },

    async searchTasks(query, tag) {
      await ensureCanRead();
      return searchTasksRaw(query, tag);
    },
  };
}
