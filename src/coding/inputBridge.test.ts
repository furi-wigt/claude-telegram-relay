import { describe, test, expect, beforeEach, mock } from "bun:test";
import { InputBridge } from "./inputBridge.ts";

/** Creates a mock Bun Subprocess with writable stdin. */
function createMockProc(options?: { exitCode?: number | null }) {
  const writtenChunks: Uint8Array[] = [];
  let ended = false;

  const proc = {
    exitCode: options?.exitCode ?? null,
    stdin: {
      write(data: Uint8Array) {
        writtenChunks.push(data);
      },
      end() {
        ended = true;
      },
    },
    pid: 12345,
  };

  return {
    proc: proc as unknown as import("bun").Subprocess,
    getWritten(): string[] {
      const decoder = new TextDecoder();
      return writtenChunks.map((chunk) => decoder.decode(chunk));
    },
    isEnded(): boolean {
      return ended;
    },
  };
}

describe("InputBridge", () => {
  describe("sendToolResult", () => {
    test("writes correctly formatted tool_result JSON to stdin", () => {
      const { proc, getWritten } = createMockProc();
      const bridge = new InputBridge(proc);

      bridge.sendToolResult("toolu_abc123", "Option A");

      const written = getWritten();
      expect(written).toHaveLength(1);
      const parsed = JSON.parse(written[0].trimEnd());
      expect(parsed).toEqual({
        type: "tool_result",
        tool_use_id: "toolu_abc123",
        content: "Option A",
      });
    });

    test("appends newline delimiter", () => {
      const { proc, getWritten } = createMockProc();
      const bridge = new InputBridge(proc);

      bridge.sendToolResult("id1", "answer");

      const raw = getWritten()[0];
      expect(raw.endsWith("\n")).toBe(true);
    });
  });

  describe("sendPlanApproval", () => {
    test("writes approve without modifications", () => {
      const { proc, getWritten } = createMockProc();
      const bridge = new InputBridge(proc);

      bridge.sendPlanApproval("req_1", true);

      const parsed = JSON.parse(getWritten()[0].trimEnd());
      expect(parsed).toEqual({
        type: "plan_approval_response",
        request_id: "req_1",
        approve: true,
      });
      expect(parsed.content).toBeUndefined();
    });

    test("writes reject with modifications", () => {
      const { proc, getWritten } = createMockProc();
      const bridge = new InputBridge(proc);

      bridge.sendPlanApproval("req_2", false, "Add error handling");

      const parsed = JSON.parse(getWritten()[0].trimEnd());
      expect(parsed).toEqual({
        type: "plan_approval_response",
        request_id: "req_2",
        approve: false,
        content: "Add error handling",
      });
    });

    test("omits content field when modifications is undefined", () => {
      const { proc, getWritten } = createMockProc();
      const bridge = new InputBridge(proc);

      bridge.sendPlanApproval("req_3", false);

      const parsed = JSON.parse(getWritten()[0].trimEnd());
      expect(parsed).not.toHaveProperty("content");
    });
  });

  describe("sendUserMessage", () => {
    test("writes nested NDJSON user message — {type,message:{role,content}}", () => {
      // Bug 5: sendUserMessage was previously sending {type:"user",content:"..."}
      // which Claude rejects. The correct format wraps the content in a message object.
      const { proc, getWritten } = createMockProc();
      const bridge = new InputBridge(proc);

      bridge.sendUserMessage("Hello Claude");

      const parsed = JSON.parse(getWritten()[0].trimEnd());
      expect(parsed).toEqual({
        type: "user",
        message: {
          role: "user",
          content: "Hello Claude",
        },
      });
    });

    test("top-level type is 'user' (not 'message' or other)", () => {
      // Ensure the outer wrapper uses type:"user" as Claude expects.
      const { proc, getWritten } = createMockProc();
      const bridge = new InputBridge(proc);

      bridge.sendUserMessage("test");

      const parsed = JSON.parse(getWritten()[0].trimEnd());
      expect(parsed.type).toBe("user");
    });

    test("message.role is 'user'", () => {
      // Claude's NDJSON protocol requires role:"user" inside the message object.
      const { proc, getWritten } = createMockProc();
      const bridge = new InputBridge(proc);

      bridge.sendUserMessage("check role");

      const parsed = JSON.parse(getWritten()[0].trimEnd());
      expect(parsed.message.role).toBe("user");
    });

    test("message.content carries the exact text passed in", () => {
      const { proc, getWritten } = createMockProc();
      const bridge = new InputBridge(proc);

      const task = "Build a REST API with authentication";
      bridge.sendUserMessage(task);

      const parsed = JSON.parse(getWritten()[0].trimEnd());
      expect(parsed.message.content).toBe(task);
    });

    test("does NOT have a top-level content field (old broken format)", () => {
      // Regression guard: old code put content at the top level, which Claude rejected.
      const { proc, getWritten } = createMockProc();
      const bridge = new InputBridge(proc);

      bridge.sendUserMessage("anything");

      const parsed = JSON.parse(getWritten()[0].trimEnd());
      expect(parsed).not.toHaveProperty("content");
    });

    test("appends newline delimiter", () => {
      const { proc, getWritten } = createMockProc();
      const bridge = new InputBridge(proc);

      bridge.sendUserMessage("line test");

      expect(getWritten()[0].endsWith("\n")).toBe(true);
    });
  });

  describe("isAlive", () => {
    test("returns true when process has no exit code", () => {
      const { proc } = createMockProc({ exitCode: null });
      const bridge = new InputBridge(proc);

      expect(bridge.isAlive()).toBe(true);
    });

    test("returns false when process has exited", () => {
      const { proc } = createMockProc({ exitCode: 0 });
      const bridge = new InputBridge(proc);

      expect(bridge.isAlive()).toBe(false);
    });

    test("returns false when process exited with error code", () => {
      const { proc } = createMockProc({ exitCode: 1 });
      const bridge = new InputBridge(proc);

      expect(bridge.isAlive()).toBe(false);
    });
  });

  describe("close", () => {
    test("calls end on stdin", () => {
      const { proc, isEnded } = createMockProc();
      const bridge = new InputBridge(proc);

      bridge.close();

      expect(isEnded()).toBe(true);
    });
  });

  describe("writeLine guard", () => {
    test("does not write when process has exited", () => {
      const { proc, getWritten } = createMockProc({ exitCode: 0 });
      const bridge = new InputBridge(proc);

      bridge.sendToolResult("id", "answer");

      expect(getWritten()).toHaveLength(0);
    });
  });
});
