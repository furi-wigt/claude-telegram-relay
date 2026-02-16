# Per-Group Queue Implementation Plan
**Date**: 2026-02-16
**Goal**: Enable concurrent Claude session processing across different Telegram groups while maintaining FIFO order within each group

## Executive Summary

**Current Problem:**
- Single global `MessageQueue` instance processes ALL messages sequentially
- Message from Group A blocks message from Group B
- No parallelization across different groups

**Solution:**
- Replace global queue with `GroupQueueManager` that maintains per-group queues
- Each Telegram chat ID gets its own `MessageQueue` instance
- Different groups process concurrently
- Same group maintains FIFO (one Claude session at a time)

**Impact:**
- ✅ Zero breaking changes (drop-in replacement)
- ✅ Production-ready reliability features
- ✅ Full backwards compatibility
- ✅ Memory management with automatic cleanup

---

## Architecture Overview

### Current Architecture (Single Queue)
```
Telegram Message → Global MessageQueue → Claude CLI
                    (blocks all groups)
```

### New Architecture (Per-Group Queues)
```
Group A Messages → Queue A → Claude CLI (parallel)
Group B Messages → Queue B → Claude CLI (parallel)
Group C Messages → Queue C → Claude CLI (parallel)
                GroupQueueManager
```

### Key Components

1. **MessageQueue** (existing, moved to module)
   - FIFO queue for sequential task processing
   - Handles one task at a time
   - Error handling and logging

2. **GroupQueueManager** (new)
   - Maintains Map<chatId, MessageQueue>
   - Creates queues on-demand
   - Tracks last activity per queue
   - Periodic cleanup of idle queues
   - Health monitoring and stats

3. **Integration Point** (relay.ts)
   - Replace: `const messageQueue = new MessageQueue()`
   - With: `const queueManager = new GroupQueueManager()`
   - Update all handlers: `queueManager.getOrCreate(chatId).enqueue(...)`

---

## Implementation Phases

### Phase 1: Core Queue System

**Files to Create:**

#### `src/queue/types.ts`
```typescript
export interface QueueTask {
  label: string;
  run: () => Promise<void>;
}

export interface QueueStats {
  chatId: number;
  agentName: string;
  depth: number;
  processing: boolean;
  lastActivity: number;
  consecutiveFailures: number;
}

export interface QueueConfig {
  maxDepth: number;
  idleTimeout: number;
  statsInterval: number;
  maxConsecutiveFailures: number;
  failureCooldown: number;
}

export interface QueueManagerStats {
  timestamp: string;
  totalQueues: number;
  activeQueues: number;
  totalDepth: number;
  queues: QueueStats[];
}
```

#### `src/queue/messageQueue.ts`
```typescript
/**
 * FIFO Queue for Sequential Task Processing
 * Moved from relay.ts for modularity
 */

import type { QueueTask } from "./types.ts";

export class MessageQueue {
  private queue: QueueTask[] = [];
  private processing = false;
  private consecutiveFailures = 0;

  get length(): number {
    return this.queue.length;
  }

  get isProcessing(): boolean {
    return this.processing;
  }

  enqueue(task: QueueTask): void {
    this.queue.push(task);
    console.log(`[queue] +${task.label} (depth: ${this.queue.length})`);
    if (!this.processing) {
      this.processQueue();
    }
  }

  private async processQueue(): Promise<void> {
    this.processing = true;
    while (this.queue.length > 0) {
      const task = this.queue.shift()!;
      const start = Date.now();
      try {
        console.log(`[queue] processing: ${task.label} (remaining: ${this.queue.length})`);
        await task.run();
        this.consecutiveFailures = 0; // Reset on success
      } catch (error) {
        console.error(`[queue] task failed (${task.label}):`, error);
        this.consecutiveFailures++;
      } finally {
        console.log(`[queue] done: ${task.label} (${Date.now() - start}ms)`);
      }
    }
    this.processing = false;
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  resetFailureCount(): void {
    this.consecutiveFailures = 0;
  }
}
```

#### `src/queue/groupQueueManager.ts`
```typescript
/**
 * Per-Group Queue Manager
 * Maintains independent MessageQueue instances for each Telegram chat
 */

import { MessageQueue } from "./messageQueue.ts";
import type { QueueConfig, QueueStats, QueueManagerStats } from "./types.ts";

const DEFAULT_CONFIG: QueueConfig = {
  maxDepth: 50,
  idleTimeout: 24 * 60 * 60 * 1000, // 24 hours
  statsInterval: 5 * 60 * 1000, // 5 minutes
  maxConsecutiveFailures: 3,
  failureCooldown: 60 * 1000, // 1 minute
};

export class GroupQueueManager {
  private queues = new Map<number, MessageQueue>();
  private lastActivity = new Map<number, number>();
  private config: QueueConfig;
  private cleanupInterval?: Timer;
  private statsInterval?: Timer;

  constructor(config?: Partial<QueueConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.startCleanupInterval();
    this.startStatsLogging();
  }

  /**
   * Get or create queue for a chat ID
   */
  getOrCreate(chatId: number): MessageQueue {
    if (!this.queues.has(chatId)) {
      this.queues.set(chatId, new MessageQueue());
      console.log(`[queue-manager] Created queue for chat ${chatId}`);
    }
    this.lastActivity.set(chatId, Date.now());
    return this.queues.get(chatId)!;
  }

  /**
   * Check if queue has capacity
   */
  hasCapacity(chatId: number): boolean {
    const queue = this.queues.get(chatId);
    return !queue || queue.length < this.config.maxDepth;
  }

  /**
   * Cleanup idle queues (empty and old)
   */
  cleanup(): void {
    const now = Date.now();
    let removed = 0;

    console.log(`[queue-manager] Cleanup started (active: ${this.queues.size})`);

    for (const [chatId, lastActive] of this.lastActivity) {
      const queue = this.queues.get(chatId);

      // Only clean up queues that are:
      // 1. Empty (no pending work)
      // 2. Old (beyond idle timeout)
      if (queue && queue.length === 0 && now - lastActive > this.config.idleTimeout) {
        this.queues.delete(chatId);
        this.lastActivity.delete(chatId);
        removed++;
        console.log(
          `[queue-manager] Removed idle queue ${chatId} (idle: ${((now - lastActive) / 3600000).toFixed(1)}h)`
        );
      }
    }

    console.log(`[queue-manager] Cleanup complete (active: ${this.queues.size}, removed: ${removed})`);
  }

  /**
   * Get statistics for all queues
   */
  getStats(): QueueManagerStats {
    const queues: QueueStats[] = [];
    let totalDepth = 0;
    let activeQueues = 0;

    for (const [chatId, queue] of this.queues) {
      const depth = queue.length;
      const processing = queue.isProcessing;

      if (depth > 0 || processing) {
        activeQueues++;
      }

      totalDepth += depth;

      queues.push({
        chatId,
        agentName: "unknown", // Will be enriched by caller if needed
        depth,
        processing,
        lastActivity: this.lastActivity.get(chatId) || 0,
        consecutiveFailures: queue.getConsecutiveFailures(),
      });
    }

    return {
      timestamp: new Date().toISOString(),
      totalQueues: this.queues.size,
      activeQueues,
      totalDepth,
      queues: queues.filter(q => q.depth > 0 || q.processing), // Only show active
    };
  }

  /**
   * Gracefully shutdown - wait for all queues to drain
   */
  async shutdown(timeoutMs: number = 30000): Promise<void> {
    console.log("[queue-manager] Graceful shutdown initiated");

    // Stop intervals
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    if (this.statsInterval) clearInterval(this.statsInterval);

    const start = Date.now();
    const pendingChats = Array.from(this.queues.entries())
      .filter(([_, queue]) => queue.length > 0 || queue.isProcessing)
      .map(([chatId]) => chatId);

    if (pendingChats.length === 0) {
      console.log("[queue-manager] No pending work, shutting down immediately");
      return;
    }

    console.log(`[queue-manager] Waiting for ${pendingChats.length} queues to drain...`);

    // Poll until all queues empty or timeout
    while (Date.now() - start < timeoutMs) {
      const stillPending = Array.from(this.queues.entries())
        .filter(([_, queue]) => queue.length > 0 || queue.isProcessing)
        .map(([chatId]) => chatId);

      if (stillPending.length === 0) {
        console.log("[queue-manager] All queues drained successfully");
        return;
      }

      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Timeout - log what's still pending
    const remainingWork = Array.from(this.queues.entries())
      .filter(([_, queue]) => queue.length > 0 || queue.isProcessing)
      .map(([chatId, queue]) => ({ chatId, depth: queue.length }));

    console.warn(
      `[queue-manager] Shutdown timeout after ${timeoutMs}ms. Remaining work:`,
      remainingWork
    );
  }

  private startCleanupInterval(): void {
    // Run cleanup every hour (configurable)
    const interval = this.config.idleTimeout / 24; // ~1 hour for 24h timeout
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, interval);
  }

  private startStatsLogging(): void {
    this.statsInterval = setInterval(() => {
      const stats = this.getStats();
      if (stats.activeQueues > 0) {
        console.log("[queue-stats]", JSON.stringify(stats, null, 2));
      }
    }, this.config.statsInterval);
  }
}
```

---

### Phase 2: Integration with relay.ts

**Changes to `src/relay.ts`:**

1. **Add imports:**
```typescript
import { GroupQueueManager } from "./queue/groupQueueManager.ts";
```

2. **Remove MessageQueue class** (lines 238-273)
   - Moved to `src/queue/messageQueue.ts`

3. **Add configuration** (after CLAUDE_TIMEOUT):
```typescript
// Queue Configuration
const QUEUE_MAX_DEPTH = parseInt(process.env.QUEUE_MAX_DEPTH || "50", 10);
const QUEUE_CLEANUP_INTERVAL = parseInt(process.env.QUEUE_CLEANUP_INTERVAL_MS || "3600000", 10);
const QUEUE_IDLE_TIMEOUT = parseInt(process.env.QUEUE_IDLE_TIMEOUT_MS || "86400000", 10);
const QUEUE_SHUTDOWN_GRACE = parseInt(process.env.QUEUE_SHUTDOWN_GRACE_MS || "30000", 10);
const QUEUE_STATS_INTERVAL = parseInt(process.env.QUEUE_STATS_LOG_INTERVAL_MS || "300000", 10);
```

4. **Replace global queue** (line 275):
```typescript
// Old: const messageQueue = new MessageQueue();
const queueManager = new GroupQueueManager({
  maxDepth: QUEUE_MAX_DEPTH,
  idleTimeout: QUEUE_IDLE_TIMEOUT,
  statsInterval: QUEUE_STATS_INTERVAL,
});
```

5. **Update text handler** (line 289-360):
```typescript
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  const chatId = ctx.chat?.id;

  if (!chatId) return;

  // Backpressure check
  if (!queueManager.hasCapacity(chatId)) {
    await ctx.reply(
      "⏸️ Too many pending messages. Please wait for the current ones to complete."
    );
    return;
  }

  queueManager.getOrCreate(chatId).enqueue({
    label: `[chat:${chatId}] ${text.substring(0, 30)}`,
    run: async () => {
      // ... existing handler code unchanged ...
    },
  });
});
```

6. **Update voice handler** (line 362-451) - same pattern
7. **Update photo handler** (line 453-515) - same pattern
8. **Update document handler** (line 517-578) - same pattern

9. **Update shutdown handlers** (line 656-666):
```typescript
process.on('SIGINT', async () => {
  console.log('Received SIGINT, shutting down gracefully...');
  await queueManager.shutdown(QUEUE_SHUTDOWN_GRACE);
  bot.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  await queueManager.shutdown(QUEUE_SHUTDOWN_GRACE);
  bot.stop();
  process.exit(0);
});
```

---

### Phase 3: Environment Configuration

**Add to `.env.example`:**
```bash
# Queue Configuration (Optional - defaults shown)
QUEUE_MAX_DEPTH=50                    # Max pending messages per group
QUEUE_CLEANUP_INTERVAL_MS=3600000     # Cleanup idle queues every 1 hour
QUEUE_IDLE_TIMEOUT_MS=86400000        # Remove queues idle for 24 hours
QUEUE_SHUTDOWN_GRACE_MS=30000         # Wait 30s for queues to drain on shutdown
QUEUE_STATS_LOG_INTERVAL_MS=300000    # Log queue stats every 5 minutes
```

---

## Production Features

### 1. Backpressure Control
- Check queue depth before enqueuing
- If depth >= maxDepth, reply immediately: "Too many pending messages"
- Prevents memory exhaustion from message spam

### 2. Graceful Shutdown
- On SIGTERM/SIGINT, wait for all queues to drain
- Timeout after configurable period (default 30s)
- Log which chats had incomplete work

### 3. Automatic Cleanup
- Periodic cleanup (default every 1 hour)
- Remove queues that are:
  - Empty (no pending work)
  - Idle (no activity for 24+ hours)
- Prevents memory leaks

### 4. Health Monitoring
- Periodic stats logging (every 5 minutes)
- Shows: active queues, depths, processing status
- Tracks consecutive failures per queue

### 5. Circuit Breaker (Future Enhancement)
- Track consecutive failures per queue
- After N failures, pause queue temporarily
- Log circuit breaker state changes

---

## Backwards Compatibility

### Zero Breaking Changes
✅ External API unchanged (Telegram bot interface)
✅ Session management unchanged (groupSessions.ts)
✅ Agent routing unchanged (groupRouter.ts)
✅ Message handlers unchanged (same signatures)
✅ Environment variables additive (new ones optional)

### Migration
- **No user action required**
- Drop-in replacement
- Existing `.env` files work as-is
- No database schema changes
- No session file format changes

### Rollback Plan
If issues arise:
1. Revert to single global queue (1-line change in relay.ts)
2. Remove GroupQueueManager import
3. Restore `const messageQueue = new MessageQueue();`

---

## Implementation Checklist

### Phase 1: Core Queue System
- [ ] Create `src/queue/types.ts`
- [ ] Create `src/queue/messageQueue.ts`
- [ ] Create `src/queue/groupQueueManager.ts`
- [ ] Add unit tests for MessageQueue
- [ ] Add unit tests for GroupQueueManager

### Phase 2: Integration
- [ ] Update `src/relay.ts` imports
- [ ] Add queue configuration (env vars)
- [ ] Replace global messageQueue with queueManager
- [ ] Update text handler
- [ ] Update voice handler
- [ ] Update photo handler
- [ ] Update document handler
- [ ] Update shutdown handlers
- [ ] Add backpressure checks

### Phase 3: Testing
- [ ] Unit tests pass
- [ ] Integration test: concurrent groups process in parallel
- [ ] Integration test: same group processes FIFO
- [ ] Edge case: backpressure limit enforced
- [ ] Edge case: graceful shutdown drains queues
- [ ] Edge case: cleanup removes idle queues
- [ ] Stress test: 50 groups, 5 messages each

### Phase 4: Documentation
- [ ] Update README.md with new features
- [ ] Create ARCHITECTURE.md
- [ ] Update TROUBLESHOOTING.md
- [ ] Add inline code comments
- [ ] Update `.env.example`

---

## Performance Expectations

### Before (Single Global Queue)
- 10 groups, 1 message each → 10 sequential tasks → ~100s total (10s each)

### After (Per-Group Queues)
- 10 groups, 1 message each → 10 parallel tasks → ~10s total (10s each)
- **10x speedup for concurrent groups**

### Memory Impact
- Small: Each MessageQueue ~1KB overhead
- 100 active groups = ~100KB additional memory
- Cleanup ensures bounded growth

---

## Monitoring & Observability

### Logs to Watch

**Queue Creation:**
```
[queue-manager] Created queue for chat 12345
```

**Queue Activity:**
```
[queue:12345] +Message enqueued (depth: 3 -> 4)
[queue:12345] Processing message (depth: 4, remaining: 3)
[queue:12345] -Message completed (depth: 3, duration: 2.5s)
```

**Periodic Stats (every 5 min):**
```json
{
  "timestamp": "2026-02-16T17:30:00Z",
  "totalQueues": 12,
  "activeQueues": 8,
  "totalDepth": 15,
  "queues": [
    { "chatId": 12345, "depth": 3, "processing": true },
    { "chatId": 67890, "depth": 2, "processing": false }
  ]
}
```

**Cleanup:**
```
[queue-manager] Cleanup started (active: 15)
[queue-manager] Removed idle queue 67890 (idle: 26.0h)
[queue-manager] Cleanup complete (active: 14, removed: 1)
```

---

## Risk Assessment

### Low Risk
✅ No breaking changes
✅ Backwards compatible
✅ Easy rollback (1-line change)
✅ Well-tested MessageQueue (existing code)

### Medium Risk
⚠️ New GroupQueueManager code (needs thorough testing)
⚠️ Memory management (mitigated by cleanup)

### Mitigation
- Comprehensive test suite (unit + integration + stress)
- Gradual rollout option (feature flag)
- Monitoring and observability
- Clear rollback plan

---

## Success Criteria

✅ Different groups process messages concurrently
✅ Same group maintains FIFO order
✅ No message loss or corruption
✅ Memory usage remains bounded
✅ Graceful shutdown works correctly
✅ All tests pass
✅ Documentation complete

---

## Next Steps

1. Review this plan with stakeholders
2. Create test plan (see separate document)
3. Implement Phase 1 (core queue system)
4. Implement Phase 2 (integration)
5. Run comprehensive test suite
6. Deploy to staging
7. Monitor for 24-48 hours
8. Deploy to production

---

**Plan Version**: 1.0
**Last Updated**: 2026-02-16
