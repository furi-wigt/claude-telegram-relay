import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import {
  rememberAttachment,
  recallAttachment,
  forgetAttachment,
  _clearAll,
  _size,
} from "./attachmentContinuity.ts";
import type { AttachmentContext } from "./commandCenter.ts";

const mkCtx = (overrides: Partial<AttachmentContext> = {}): AttachmentContext => ({
  imageContext: "vision desc",
  documentContext: "doc listing",
  attachmentPaths: ["/tmp/a.pdf"],
  ...overrides,
});

describe("attachmentContinuity", () => {
  beforeEach(() => {
    _clearAll();
  });

  afterEach(() => {
    _clearAll();
  });

  describe("rememberAttachment + recallAttachment", () => {
    it("stores and retrieves an attachment context", () => {
      const ctx = mkCtx();
      rememberAttachment(123, "cloud-architect", ctx);
      expect(recallAttachment(123, "cloud-architect")).toEqual(ctx);
    });

    it("scopes by (chatId, agentId) — different chats do not collide", () => {
      const a = mkCtx({ imageContext: "A" });
      const b = mkCtx({ imageContext: "B" });
      rememberAttachment(111, "eng", a);
      rememberAttachment(222, "eng", b);
      expect(recallAttachment(111, "eng")?.imageContext).toBe("A");
      expect(recallAttachment(222, "eng")?.imageContext).toBe("B");
    });

    it("scopes by agent — different agents in same chat do not collide", () => {
      rememberAttachment(1, "a", mkCtx({ imageContext: "A" }));
      rememberAttachment(1, "b", mkCtx({ imageContext: "B" }));
      expect(recallAttachment(1, "a")?.imageContext).toBe("A");
      expect(recallAttachment(1, "b")?.imageContext).toBe("B");
    });

    it("returns null for unknown key", () => {
      expect(recallAttachment(999, "ghost")).toBeNull();
    });

    it("overwrites on repeat remember", () => {
      rememberAttachment(1, "a", mkCtx({ imageContext: "old" }));
      rememberAttachment(1, "a", mkCtx({ imageContext: "new" }));
      expect(recallAttachment(1, "a")?.imageContext).toBe("new");
    });

    it("no-op when context has no useful content", () => {
      rememberAttachment(1, "a", { imageContext: undefined, documentContext: undefined, attachmentPaths: undefined });
      expect(_size()).toBe(0);
      expect(recallAttachment(1, "a")).toBeNull();
    });

    it("no-op when attachmentPaths is empty array and no contexts", () => {
      rememberAttachment(1, "a", { attachmentPaths: [] });
      expect(_size()).toBe(0);
    });

    it("remembers when only attachmentPaths present", () => {
      rememberAttachment(1, "a", { attachmentPaths: ["/tmp/x.pdf"] });
      expect(recallAttachment(1, "a")?.attachmentPaths).toEqual(["/tmp/x.pdf"]);
    });

    it("remembers when only imageContext present", () => {
      rememberAttachment(1, "a", { imageContext: "img" });
      expect(recallAttachment(1, "a")?.imageContext).toBe("img");
    });

    it("remembers when only documentContext present", () => {
      rememberAttachment(1, "a", { documentContext: "doc" });
      expect(recallAttachment(1, "a")?.documentContext).toBe("doc");
    });
  });

  describe("TTL expiry (30 min)", () => {
    it("returns stored value within TTL", () => {
      const now = 1_000_000_000;
      const dateSpy = spyOn(Date, "now").mockReturnValue(now);

      rememberAttachment(1, "a", mkCtx());
      dateSpy.mockReturnValue(now + 29 * 60 * 1000);

      expect(recallAttachment(1, "a")).not.toBeNull();
      dateSpy.mockRestore();
    });

    it("returns null after TTL elapses and lazily evicts", () => {
      const now = 2_000_000_000;
      const dateSpy = spyOn(Date, "now").mockReturnValue(now);

      rememberAttachment(1, "a", mkCtx());
      expect(_size()).toBe(1);

      dateSpy.mockReturnValue(now + 30 * 60 * 1000 + 1);
      expect(recallAttachment(1, "a")).toBeNull();
      expect(_size()).toBe(0);
      dateSpy.mockRestore();
    });

    it("TTL boundary — exactly at expiry is considered expired", () => {
      const now = 3_000_000_000;
      const dateSpy = spyOn(Date, "now").mockReturnValue(now);

      rememberAttachment(1, "a", mkCtx());
      dateSpy.mockReturnValue(now + 30 * 60 * 1000);
      expect(recallAttachment(1, "a")).toBeNull();
      dateSpy.mockRestore();
    });
  });

  describe("forgetAttachment", () => {
    it("removes a single (chatId, agentId) entry", () => {
      rememberAttachment(1, "a", mkCtx());
      rememberAttachment(1, "b", mkCtx());
      forgetAttachment(1, "a");
      expect(recallAttachment(1, "a")).toBeNull();
      expect(recallAttachment(1, "b")).not.toBeNull();
    });

    it("removes all entries for a chat when agentId omitted (/new semantics)", () => {
      rememberAttachment(1, "a", mkCtx());
      rememberAttachment(1, "b", mkCtx());
      rememberAttachment(2, "a", mkCtx());
      forgetAttachment(1);
      expect(recallAttachment(1, "a")).toBeNull();
      expect(recallAttachment(1, "b")).toBeNull();
      expect(recallAttachment(2, "a")).not.toBeNull();
    });

    it("no-op on unknown key", () => {
      forgetAttachment(999);
      forgetAttachment(999, "ghost");
      expect(_size()).toBe(0);
    });
  });

  describe("capacity cap (200 entries)", () => {
    it("evicts oldest entry when cap is hit", () => {
      const now = 4_000_000_000;
      const dateSpy = spyOn(Date, "now");

      // Fill to 200
      for (let i = 0; i < 200; i++) {
        dateSpy.mockReturnValue(now + i);
        rememberAttachment(i, "a", mkCtx({ imageContext: `ctx-${i}` }));
      }
      expect(_size()).toBe(200);

      // Add one more — should evict the earliest (chatId=0)
      dateSpy.mockReturnValue(now + 200);
      rememberAttachment(999, "a", mkCtx({ imageContext: "new" }));

      expect(_size()).toBe(200);
      expect(recallAttachment(0, "a")).toBeNull();
      expect(recallAttachment(999, "a")?.imageContext).toBe("new");
      dateSpy.mockRestore();
    });

    it("overwriting an existing key at cap does not trigger eviction", () => {
      const now = 5_000_000_000;
      const dateSpy = spyOn(Date, "now");

      for (let i = 0; i < 200; i++) {
        dateSpy.mockReturnValue(now + i);
        rememberAttachment(i, "a", mkCtx());
      }
      dateSpy.mockReturnValue(now + 200);
      rememberAttachment(50, "a", mkCtx({ imageContext: "updated" }));

      expect(_size()).toBe(200);
      expect(recallAttachment(50, "a")?.imageContext).toBe("updated");
      expect(recallAttachment(0, "a")).not.toBeNull();
      dateSpy.mockRestore();
    });
  });
});
