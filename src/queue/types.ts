export interface QueueTask {
  label: string;
  run: () => Promise<void>;
}

export interface QueueStats {
  chatId: number;
  threadId?: number;
  depth: number;
  processing: boolean;
  lastActivity: number;
  consecutiveFailures: number;
}

export interface QueueConfig {
  maxDepth: number;
  idleTimeout: number;
  statsInterval: number;
}

export interface QueueManagerStats {
  timestamp: string;
  totalQueues: number;
  activeQueues: number;
  totalDepth: number;
  queues: QueueStats[];
}
