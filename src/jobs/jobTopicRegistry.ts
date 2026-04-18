// src/jobs/jobTopicRegistry.ts
// In-memory registry mapping a CC forum topicId → job metadata.
// Used by commandCenter.ts to detect follow-up messages in job topics.
// Lives only in memory — after restart, follow-ups fall through to normal CC routing.

export interface JobTopicEntry {
  jobId: string;
  prompt: string;
  agentId: string;
}

const registry = new Map<number, JobTopicEntry>();

export function registerJobTopic(topicId: number, entry: JobTopicEntry): void {
  registry.set(topicId, entry);
}

export function getJobTopic(topicId: number): JobTopicEntry | undefined {
  return registry.get(topicId);
}

export function isJobTopic(topicId: number): boolean {
  return registry.has(topicId);
}

/** Exposed for testing only */
export function _clearRegistry(): void {
  registry.clear();
}
