import { describe, test, expect, mock, beforeEach } from "bun:test";

// Mock dependencies before importing
const mockGenerateTopic = mock(() => Promise.resolve("generated topic"));
const mockRun = mock(() => {});
const mockGetDb = mock(() => ({ run: mockRun }));

mock.module("./topicGenerator.ts", () => ({
  generateTopic: mockGenerateTopic,
}));
mock.module("../local/db.ts", () => ({
  getDb: mockGetDb,
}));

const { enqueue, _drain, _queue } = await import("./topicQueue.ts");

describe("topicQueue", () => {
  beforeEach(() => {
    // Clear the queue
    _queue.splice(0, _queue.length);
    mockGenerateTopic.mockReset();
    mockGenerateTopic.mockResolvedValue("generated topic");
    mockRun.mockReset();
    mockGetDb.mockReset();
    mockGetDb.mockReturnValue({ run: mockRun });
  });

  describe("enqueue", () => {
    test("does not block — returns void synchronously", () => {
      const result = enqueue("msg-1", "Some content");
      expect(result).toBeUndefined();
    });

    test("pushes to internal queue", () => {
      enqueue("msg-1", "Content A");
      enqueue("msg-2", "Content B");

      expect(_queue).toHaveLength(2);
      expect(_queue[0]).toEqual({ messageId: "msg-1", content: "Content A" });
      expect(_queue[1]).toEqual({ messageId: "msg-2", content: "Content B" });
    });
  });

  describe("drain", () => {
    test("no-ops when queue is empty", async () => {
      await _drain();
      expect(mockGenerateTopic).not.toHaveBeenCalled();
    });

    test("calls generateTopic and updates DB for each queued item", async () => {
      enqueue("msg-1", "First message content that is long enough");
      enqueue("msg-2", "Second message content that is also long enough");

      await _drain();

      expect(mockGenerateTopic).toHaveBeenCalledTimes(2);
      expect(mockGenerateTopic).toHaveBeenCalledWith("First message content that is long enough");
      expect(mockGenerateTopic).toHaveBeenCalledWith("Second message content that is also long enough");

      expect(mockRun).toHaveBeenCalledTimes(2);
      expect(mockRun).toHaveBeenCalledWith(
        "UPDATE messages SET topic = ? WHERE id = ?",
        ["generated topic", "msg-1"]
      );
      expect(mockRun).toHaveBeenCalledWith(
        "UPDATE messages SET topic = ? WHERE id = ?",
        ["generated topic", "msg-2"]
      );

      expect(_queue).toHaveLength(0);
    });

    test("processes at most 5 items per drain", async () => {
      for (let i = 0; i < 8; i++) {
        enqueue(`msg-${i}`, `Content ${i}`);
      }

      await _drain();

      expect(mockGenerateTopic).toHaveBeenCalledTimes(5);
      expect(_queue).toHaveLength(3);
    });

    test("continues processing remaining items on generateTopic failure", async () => {
      mockGenerateTopic
        .mockRejectedValueOnce(new Error("Ollama down"))
        .mockResolvedValueOnce("topic for msg-2");

      enqueue("msg-1", "Will fail");
      enqueue("msg-2", "Will succeed");

      await _drain();

      // msg-1 failed, msg-2 succeeded
      expect(mockRun).toHaveBeenCalledTimes(1);
      expect(mockRun).toHaveBeenCalledWith(
        "UPDATE messages SET topic = ? WHERE id = ?",
        ["topic for msg-2", "msg-2"]
      );
      expect(_queue).toHaveLength(0);
    });
  });
});
