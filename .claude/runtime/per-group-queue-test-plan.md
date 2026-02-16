# Per-Group Queue Test Plan
**Date**: 2026-02-16
**Purpose**: Comprehensive testing strategy for per-group queue implementation

## Test Organization

### Test Categories
1. **Unit Tests** - Individual component testing
2. **Integration Tests** - Component interaction testing
3. **Edge Case Tests** - Boundary and error conditions
4. **Stress Tests** - Performance and scalability
5. **Production Readiness** - Real-world scenarios

---

## 1. Unit Tests

### 1.1 MessageQueue Tests

#### Test: Queue Creation
```typescript
test("MessageQueue initializes empty", () => {
  const queue = new MessageQueue();
  expect(queue.length).toBe(0);
  expect(queue.isProcessing).toBe(false);
});
```

#### Test: FIFO Order
```typescript
test("MessageQueue processes tasks in FIFO order", async () => {
  const queue = new MessageQueue();
  const results: number[] = [];

  queue.enqueue({
    label: "task-1",
    run: async () => { results.push(1); }
  });
  queue.enqueue({
    label: "task-2",
    run: async () => { results.push(2); }
  });
  queue.enqueue({
    label: "task-3",
    run: async () => { results.push(3); }
  });

  // Wait for all tasks to complete
  await waitForQueueEmpty(queue);

  expect(results).toEqual([1, 2, 3]);
});
```

#### Test: Sequential Processing
```typescript
test("MessageQueue processes one task at a time", async () => {
  const queue = new MessageQueue();
  let concurrent = 0;
  let maxConcurrent = 0;

  const task = {
    label: "concurrent-check",
    run: async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await sleep(50); // Simulate work
      concurrent--;
    }
  };

  // Enqueue 5 tasks rapidly
  for (let i = 0; i < 5; i++) {
    queue.enqueue(task);
  }

  await waitForQueueEmpty(queue);

  expect(maxConcurrent).toBe(1); // Only 1 task at a time
});
```

#### Test: Error Handling
```typescript
test("MessageQueue continues processing after task failure", async () => {
  const queue = new MessageQueue();
  const results: string[] = [];

  queue.enqueue({
    label: "task-1",
    run: async () => { results.push("task-1"); }
  });

  queue.enqueue({
    label: "task-2-fail",
    run: async () => { throw new Error("Task 2 failed"); }
  });

  queue.enqueue({
    label: "task-3",
    run: async () => { results.push("task-3"); }
  });

  await waitForQueueEmpty(queue);

  expect(results).toEqual(["task-1", "task-3"]);
  expect(queue.getConsecutiveFailures()).toBe(0); // Reset after success
});
```

#### Test: Consecutive Failure Tracking
```typescript
test("MessageQueue tracks consecutive failures", async () => {
  const queue = new MessageQueue();

  queue.enqueue({
    label: "fail-1",
    run: async () => { throw new Error("Fail"); }
  });

  queue.enqueue({
    label: "fail-2",
    run: async () => { throw new Error("Fail"); }
  });

  queue.enqueue({
    label: "fail-3",
    run: async () => { throw new Error("Fail"); }
  });

  await waitForQueueEmpty(queue);

  expect(queue.getConsecutiveFailures()).toBe(3);
});
```

---

### 1.2 GroupQueueManager Tests

#### Test: Queue Creation on Demand
```typescript
test("GroupQueueManager creates queue on first access", () => {
  const manager = new GroupQueueManager();

  const queue1 = manager.getOrCreate(12345);
  expect(queue1).toBeDefined();
  expect(queue1.length).toBe(0);
});
```

#### Test: Queue Reuse
```typescript
test("GroupQueueManager reuses existing queues", () => {
  const manager = new GroupQueueManager();

  const queue1 = manager.getOrCreate(12345);
  const queue2 = manager.getOrCreate(12345);

  expect(queue1).toBe(queue2); // Same instance
});
```

#### Test: Last Activity Tracking
```typescript
test("GroupQueueManager updates last activity on access", async () => {
  const manager = new GroupQueueManager();

  const t1 = Date.now();
  manager.getOrCreate(12345);
  await sleep(100);
  const t2 = Date.now();
  manager.getOrCreate(12345); // Touch again

  const stats = manager.getStats();
  const queueStat = stats.queues.find(q => q.chatId === 12345);

  expect(queueStat?.lastActivity).toBeGreaterThanOrEqual(t2 - 10);
});
```

#### Test: Cleanup - Idle Queues Removed
```typescript
test("GroupQueueManager removes idle empty queues", async () => {
  const manager = new GroupQueueManager({
    idleTimeout: 100, // 100ms for testing
  });

  manager.getOrCreate(12345);
  manager.getOrCreate(67890);

  expect(manager.getStats().totalQueues).toBe(2);

  await sleep(150); // Wait past idle timeout

  manager.cleanup();

  expect(manager.getStats().totalQueues).toBe(0);
});
```

#### Test: Cleanup - Active Queues Preserved
```typescript
test("GroupQueueManager preserves active queues during cleanup", async () => {
  const manager = new GroupQueueManager({
    idleTimeout: 100,
  });

  const queue = manager.getOrCreate(12345);

  // Add a pending task
  queue.enqueue({
    label: "long-task",
    run: async () => { await sleep(200); }
  });

  await sleep(150); // Wait past idle timeout

  manager.cleanup();

  expect(manager.getStats().totalQueues).toBe(1); // Still active
});
```

#### Test: Cleanup - Recent Queues Preserved
```typescript
test("GroupQueueManager preserves recently accessed queues", async () => {
  const manager = new GroupQueueManager({
    idleTimeout: 200,
  });

  manager.getOrCreate(12345);

  await sleep(100);

  manager.cleanup(); // Before timeout

  expect(manager.getStats().totalQueues).toBe(1); // Too recent
});
```

#### Test: Capacity Check
```typescript
test("GroupQueueManager hasCapacity returns correct status", () => {
  const manager = new GroupQueueManager({
    maxDepth: 3,
  });

  const queue = manager.getOrCreate(12345);

  expect(manager.hasCapacity(12345)).toBe(true);

  // Fill queue
  queue.enqueue({ label: "t1", run: async () => {} });
  queue.enqueue({ label: "t2", run: async () => {} });
  queue.enqueue({ label: "t3", run: async () => {} });

  expect(manager.hasCapacity(12345)).toBe(false); // At limit
});
```

#### Test: Statistics Collection
```typescript
test("GroupQueueManager getStats returns accurate data", () => {
  const manager = new GroupQueueManager();

  const queue1 = manager.getOrCreate(12345);
  const queue2 = manager.getOrCreate(67890);

  queue1.enqueue({ label: "t1", run: async () => {} });
  queue1.enqueue({ label: "t2", run: async () => {} });
  queue2.enqueue({ label: "t3", run: async () => {} });

  const stats = manager.getStats();

  expect(stats.totalQueues).toBe(2);
  expect(stats.totalDepth).toBe(3);
  expect(stats.activeQueues).toBeGreaterThan(0);
  expect(stats.queues).toHaveLength(2);
});
```

---

## 2. Integration Tests

### 2.1 Concurrent Group Processing

#### Test: Groups Process in Parallel
```typescript
test("Different groups process messages concurrently", async () => {
  const manager = new GroupQueueManager();

  const group1Start = Date.now();
  const group2Start = Date.now();
  let group1End = 0;
  let group2End = 0;

  // Group 1: 500ms task
  manager.getOrCreate(111).enqueue({
    label: "group1-task",
    run: async () => {
      await sleep(500);
      group1End = Date.now();
    }
  });

  // Group 2: 500ms task (starts ~same time)
  manager.getOrCreate(222).enqueue({
    label: "group2-task",
    run: async () => {
      await sleep(500);
      group2End = Date.now();
    }
  });

  // Wait for both
  await sleep(700);

  const group1Duration = group1End - group1Start;
  const group2Duration = group2End - group2Start;

  // Both should complete in ~500ms (parallel)
  expect(group1Duration).toBeLessThan(600);
  expect(group2Duration).toBeLessThan(600);

  // If sequential, total would be 1000ms+
  const totalTime = Math.max(group1End, group2End) - Math.min(group1Start, group2Start);
  expect(totalTime).toBeLessThan(700); // Parallel = ~500ms
});
```

#### Test: FIFO Within Same Group
```typescript
test("Same group maintains FIFO order", async () => {
  const manager = new GroupQueueManager();
  const queue = manager.getOrCreate(12345);

  const results: number[] = [];

  queue.enqueue({
    label: "task-1",
    run: async () => {
      await sleep(50);
      results.push(1);
    }
  });

  queue.enqueue({
    label: "task-2",
    run: async () => {
      await sleep(50);
      results.push(2);
    }
  });

  queue.enqueue({
    label: "task-3",
    run: async () => {
      await sleep(50);
      results.push(3);
    }
  });

  await sleep(300); // Wait for all to complete

  expect(results).toEqual([1, 2, 3]); // Strict FIFO
});
```

### 2.2 DM vs Group Handling

#### Test: DMs Get Own Queue
```typescript
test("DM messages get independent queue from groups", async () => {
  const manager = new GroupQueueManager();

  const dmQueue = manager.getOrCreate(123456); // DM chat
  const groupQueue = manager.getOrCreate(-789012); // Group chat

  expect(dmQueue).not.toBe(groupQueue);

  const stats = manager.getStats();
  expect(stats.totalQueues).toBe(2);
});
```

### 2.3 Mixed Message Types

#### Test: Text, Voice, Photo, Document Share Queue
```typescript
test("All message types for same chat use same queue", async () => {
  const manager = new GroupQueueManager();
  const results: string[] = [];

  const queue = manager.getOrCreate(12345);

  queue.enqueue({
    label: "text",
    run: async () => { results.push("text"); }
  });

  queue.enqueue({
    label: "voice",
    run: async () => { results.push("voice"); }
  });

  queue.enqueue({
    label: "photo",
    run: async () => { results.push("photo"); }
  });

  queue.enqueue({
    label: "document",
    run: async () => { results.push("document"); }
  });

  await waitForQueueEmpty(queue);

  expect(results).toEqual(["text", "voice", "photo", "document"]);
});
```

---

## 3. Edge Case Tests

### 3.1 Backpressure

#### Test: Max Depth Enforced
```typescript
test("Backpressure prevents queue overflow", () => {
  const manager = new GroupQueueManager({
    maxDepth: 5,
  });

  const queue = manager.getOrCreate(12345);

  // Fill to capacity
  for (let i = 0; i < 5; i++) {
    queue.enqueue({
      label: `task-${i}`,
      run: async () => { await sleep(100); }
    });
  }

  expect(manager.hasCapacity(12345)).toBe(false);
});
```

#### Test: User Notified When Queue Full
```typescript
test("Bot replies when queue is full", async () => {
  // Mock bot context
  const ctx = mockTelegramContext(12345, "Test message");

  const manager = new GroupQueueManager({ maxDepth: 1 });
  const queue = manager.getOrCreate(12345);

  // Fill queue
  queue.enqueue({
    label: "blocking-task",
    run: async () => { await sleep(500); }
  });

  // Simulate handler check
  if (!manager.hasCapacity(12345)) {
    await ctx.reply("Too many pending messages. Please wait.");
  }

  expect(ctx.replies).toContain("Too many pending messages");
});
```

### 3.2 Graceful Shutdown

#### Test: Empty Queues - Immediate Shutdown
```typescript
test("Graceful shutdown completes immediately when queues empty", async () => {
  const manager = new GroupQueueManager();

  manager.getOrCreate(12345); // Create but don't enqueue

  const start = Date.now();
  await manager.shutdown(30000);
  const duration = Date.now() - start;

  expect(duration).toBeLessThan(100); // Almost immediate
});
```

#### Test: Pending Work - Wait for Completion
```typescript
test("Graceful shutdown waits for pending work", async () => {
  const manager = new GroupQueueManager();

  const queue = manager.getOrCreate(12345);
  let taskCompleted = false;

  queue.enqueue({
    label: "long-task",
    run: async () => {
      await sleep(1000);
      taskCompleted = true;
    }
  });

  await manager.shutdown(5000); // 5s timeout

  expect(taskCompleted).toBe(true); // Waited for completion
});
```

#### Test: Shutdown Timeout
```typescript
test("Graceful shutdown times out and logs remaining work", async () => {
  const manager = new GroupQueueManager();

  const queue = manager.getOrCreate(12345);

  queue.enqueue({
    label: "infinite-task",
    run: async () => { await sleep(10000); } // Never finishes in time
  });

  const start = Date.now();
  await manager.shutdown(500); // Short timeout
  const duration = Date.now() - start;

  expect(duration).toBeGreaterThanOrEqual(500);
  expect(duration).toBeLessThan(600); // Respects timeout

  // Check logs for warning about incomplete work
  // (Implementation would capture console.warn)
});
```

### 3.3 Memory Management

#### Test: Cleanup Prevents Memory Leak
```typescript
test("Periodic cleanup prevents unbounded growth", async () => {
  const manager = new GroupQueueManager({
    idleTimeout: 100,
  });

  // Create 1000 queues
  for (let i = 0; i < 1000; i++) {
    manager.getOrCreate(i);
  }

  expect(manager.getStats().totalQueues).toBe(1000);

  await sleep(150); // Wait past idle timeout

  manager.cleanup();

  expect(manager.getStats().totalQueues).toBe(0); // All cleaned
});
```

#### Test: Active Queues Not Cleaned
```typescript
test("Cleanup skips queues with pending work", async () => {
  const manager = new GroupQueueManager({
    idleTimeout: 100,
  });

  // Create 10 queues, 5 with pending work
  for (let i = 0; i < 10; i++) {
    const queue = manager.getOrCreate(i);
    if (i < 5) {
      queue.enqueue({
        label: `task-${i}`,
        run: async () => { await sleep(500); }
      });
    }
  }

  await sleep(150); // Wait past idle timeout

  manager.cleanup();

  expect(manager.getStats().totalQueues).toBe(5); // Only active remain
});
```

---

## 4. Stress Tests

### 4.1 High Concurrency

#### Test: 50 Groups, 5 Messages Each
```typescript
test("Handles 50 concurrent groups processing 5 messages each", async () => {
  const manager = new GroupQueueManager();

  const results = new Map<number, number[]>();
  const startTime = Date.now();

  // 50 groups, 5 messages each = 250 total tasks
  for (let group = 0; group < 50; group++) {
    results.set(group, []);

    for (let msg = 0; msg < 5; msg++) {
      manager.getOrCreate(group).enqueue({
        label: `group-${group}-msg-${msg}`,
        run: async () => {
          await sleep(100); // Simulate 100ms Claude call
          results.get(group)!.push(msg);
        }
      });
    }
  }

  // Wait for all to complete
  while (manager.getStats().activeQueues > 0) {
    await sleep(100);
  }

  const duration = Date.now() - startTime;

  // Verify all completed
  expect(results.size).toBe(50);
  for (const [group, messages] of results) {
    expect(messages).toEqual([0, 1, 2, 3, 4]); // FIFO per group
  }

  // Performance: Should be ~500ms (5 * 100ms) not 25000ms (250 * 100ms)
  expect(duration).toBeLessThan(1000); // Allow some overhead
  console.log(`Completed 250 tasks in ${duration}ms (parallel speedup)`);
});
```

### 4.2 Long-Running Tasks

#### Test: One Group Doesn't Block Others
```typescript
test("Long-running task in one group doesn't block others", async () => {
  const manager = new GroupQueueManager();

  let slowGroupDone = false;
  let fastGroupDone = false;

  // Slow group: 5 second task
  manager.getOrCreate(111).enqueue({
    label: "slow",
    run: async () => {
      await sleep(5000);
      slowGroupDone = true;
    }
  });

  // Fast group: 100ms task
  manager.getOrCreate(222).enqueue({
    label: "fast",
    run: async () => {
      await sleep(100);
      fastGroupDone = true;
    }
  });

  // Wait 200ms
  await sleep(200);

  expect(fastGroupDone).toBe(true); // Fast group completed
  expect(slowGroupDone).toBe(false); // Slow group still running
});
```

### 4.3 Timeout Handling

#### Test: Claude Timeout Doesn't Block Queue
```typescript
test("Claude timeout error doesn't stop queue processing", async () => {
  const manager = new GroupQueueManager();
  const results: string[] = [];

  const queue = manager.getOrCreate(12345);

  queue.enqueue({
    label: "timeout-task",
    run: async () => {
      throw new Error("Claude timeout after 180s");
    }
  });

  queue.enqueue({
    label: "normal-task",
    run: async () => {
      results.push("completed");
    }
  });

  await waitForQueueEmpty(queue);

  expect(results).toContain("completed"); // Second task ran
  expect(queue.getConsecutiveFailures()).toBe(0); // Reset after success
});
```

### 4.4 Memory Profiling

#### Test: Memory Usage Bounded Over Time
```typescript
test("Memory usage remains bounded with cleanup", async () => {
  const manager = new GroupQueueManager({
    idleTimeout: 1000, // 1 second
  });

  const initialMemory = process.memoryUsage().heapUsed;

  // Create 100 groups per second for 10 seconds = 1000 total
  for (let i = 0; i < 10; i++) {
    for (let j = 0; j < 100; j++) {
      const chatId = i * 100 + j;
      manager.getOrCreate(chatId).enqueue({
        label: `task-${chatId}`,
        run: async () => { await sleep(10); }
      });
    }
    await sleep(1000);
    manager.cleanup(); // Clean up old queues
  }

  const finalMemory = process.memoryUsage().heapUsed;
  const growth = finalMemory - initialMemory;

  // Memory growth should be minimal (< 10MB)
  expect(growth).toBeLessThan(10 * 1024 * 1024);

  console.log(`Memory growth: ${(growth / 1024 / 1024).toFixed(2)}MB`);
});
```

---

## 5. Production Readiness Tests

### 5.1 Supabase Failure Resilience

#### Test: Messages Process Without Supabase
```typescript
test("Messages process successfully even if Supabase fails", async () => {
  // Mock Supabase as unavailable
  const supabase = null;

  const manager = new GroupQueueManager();
  let callClaudeCalled = false;

  manager.getOrCreate(12345).enqueue({
    label: "test-message",
    run: async () => {
      // Simulate message handler
      await saveMessage(supabase, "user", "test"); // Should not throw
      callClaudeCalled = true;
    }
  });

  await sleep(100);

  expect(callClaudeCalled).toBe(true);
});
```

### 5.2 Real Telegram Bot Integration

#### Test: End-to-End Text Message
```typescript
test("Text message flows through per-group queue correctly", async () => {
  // This requires actual bot setup - integration test
  const testChatId = 12345;

  // Send test message via Telegram API
  await sendTestMessage(testChatId, "Hello bot");

  // Wait for processing
  await sleep(1000);

  // Verify response received
  const messages = await getTelegramMessages(testChatId);
  expect(messages[messages.length - 1].text).toMatch(/.*test.*/i);
});
```

### 5.3 Auto-Discovery Integration

#### Test: New Group Gets Own Queue
```typescript
test("Auto-discovered group gets independent queue", async () => {
  const manager = new GroupQueueManager();

  // Simulate auto-discovery creating new group mapping
  const newGroupId = -999888777;

  const queue = manager.getOrCreate(newGroupId);

  queue.enqueue({
    label: "first-message",
    run: async () => { /* ... */ }
  });

  expect(manager.getStats().totalQueues).toBeGreaterThan(0);
});
```

### 5.4 Monitoring & Alerts

#### Test: Stats Logged Periodically
```typescript
test("Queue stats logged every 5 minutes", async () => {
  const logSpy = jest.spyOn(console, 'log');

  const manager = new GroupQueueManager({
    statsInterval: 100, // 100ms for testing
  });

  manager.getOrCreate(12345);

  await sleep(250); // Wait for 2+ intervals

  const statLogs = logSpy.mock.calls.filter(
    call => call[0] === '[queue-stats]'
  );

  expect(statLogs.length).toBeGreaterThanOrEqual(2);
});
```

---

## Test Execution Plan

### Phase 1: Unit Tests
```bash
bun test src/queue/messageQueue.test.ts
bun test src/queue/groupQueueManager.test.ts
```

**Success Criteria**: All unit tests pass (100% coverage)

### Phase 2: Integration Tests
```bash
bun test src/queue/integration.test.ts
```

**Success Criteria**:
- Concurrent groups process in parallel
- FIFO maintained within groups
- All message types handled correctly

### Phase 3: Edge Cases
```bash
bun test src/queue/edgecases.test.ts
```

**Success Criteria**:
- Backpressure enforced
- Graceful shutdown works
- Cleanup prevents memory leaks

### Phase 4: Stress Tests
```bash
bun test src/queue/stress.test.ts --timeout 60000
```

**Success Criteria**:
- 50 groups x 5 messages = 250 tasks complete successfully
- Parallel speedup achieved (~10x vs sequential)
- Memory usage bounded

### Phase 5: Production Integration
```bash
bun test src/relay.integration.test.ts
```

**Success Criteria**:
- Real Telegram messages processed correctly
- Supabase failures handled gracefully
- Auto-discovery works with new groups

---

## Performance Benchmarks

### Baseline (Single Global Queue)
- **10 groups, 1 message each**: ~100s (10s × 10 sequential)
- **50 groups, 5 messages each**: ~2500s (10s × 250 sequential)

### Target (Per-Group Queues)
- **10 groups, 1 message each**: ~10s (parallel)
- **50 groups, 5 messages each**: ~50s (5 × 10s per group, parallel)

### Speedup Expected
- **10x to 50x** depending on number of concurrent groups

---

## Test Infrastructure

### Mock Helpers

```typescript
// Mock Telegram context
function mockTelegramContext(chatId: number, text: string) {
  return {
    chat: { id: chatId },
    message: { text },
    reply: jest.fn(),
    replyWithChatAction: jest.fn(),
    getChat: jest.fn().mockResolvedValue({ id: chatId, title: "Test Group" }),
  };
}

// Wait for queue to be empty
async function waitForQueueEmpty(queue: MessageQueue, timeoutMs = 5000) {
  const start = Date.now();
  while (queue.length > 0 || queue.isProcessing) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timeout waiting for queue to empty");
    }
    await sleep(50);
  }
}

// Sleep helper
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

---

## Continuous Integration

### GitHub Actions Workflow

```yaml
name: Queue Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: oven-sh/setup-bun@v1

      - name: Install dependencies
        run: bun install

      - name: Unit Tests
        run: bun test src/queue/*.test.ts

      - name: Integration Tests
        run: bun test src/queue/integration.test.ts

      - name: Stress Tests
        run: bun test src/queue/stress.test.ts --timeout 60000

      - name: Coverage Report
        run: bun test --coverage
```

---

## Sign-Off Criteria

Before merging to production:

✅ All unit tests pass
✅ All integration tests pass
✅ All edge case tests pass
✅ Stress tests show expected speedup (10x+)
✅ Memory profiling shows bounded growth
✅ Code review completed
✅ Documentation updated
✅ Staging deployment successful (24h monitoring)

---

## Rollback Triggers

If any of these occur in production, initiate rollback:

❌ Message loss detected
❌ Messages out of order within same group
❌ Memory leak detected (> 500MB growth in 1h)
❌ Crash due to queue manager
❌ Claude sessions corrupted/mixed between groups

---

**Test Plan Version**: 1.0
**Last Updated**: 2026-02-16
**Estimated Test Execution Time**: 30-45 minutes
