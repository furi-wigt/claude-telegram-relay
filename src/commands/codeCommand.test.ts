import { describe, test, expect } from "bun:test";
import { parseCodeCommand, buildStatusCard } from "./codeCommand.ts";
import type { RemoteSession } from "../remote/remoteSessionManager.ts";

describe("parseCodeCommand()", () => {
  test("bare /code → start, no dir", () => {
    expect(parseCodeCommand("/code")).toEqual({ subcommand: "start", dir: undefined });
  });

  test("/code with @botname suffix → start, no dir", () => {
    expect(parseCodeCommand("/code@mybot")).toEqual({ subcommand: "start", dir: undefined });
  });

  test("/code ~/projects/my-app → start with dir", () => {
    expect(parseCodeCommand("/code ~/projects/my-app")).toEqual({
      subcommand: "start",
      dir: "~/projects/my-app",
    });
  });

  test("/code stop → stop", () => {
    expect(parseCodeCommand("/code stop")).toEqual({ subcommand: "stop", dir: undefined });
  });

  test("/code status → status", () => {
    expect(parseCodeCommand("/code status")).toEqual({ subcommand: "status", dir: undefined });
  });

  test("/code@botname stop → stop", () => {
    expect(parseCodeCommand("/code@botname stop")).toEqual({ subcommand: "stop", dir: undefined });
  });
});

describe("buildStatusCard()", () => {
  test("null session → no active session message", () => {
    const result = buildStatusCard(null);
    expect(result).toContain("No active coding session");
    expect(result).toContain("/code [path]");
  });

  test("live session with all fields → full card", () => {
    const session: RemoteSession = {
      name: "jarvis-1745123456",
      pid: 12345,
      dir: `${process.env.HOME}/projects/my-app`,
      specPath: `${process.env.HOME}/.claude-relay/specs/260425_1034_01_feature-spec.md`,
      sessionUrl: "https://claude.ai/code?session=abc123",
      permissionMode: "plan",
      startedAt: "2026-04-25T03:34:00.000Z",
      chatId: -1001234567890,
      threadId: null,
    };
    const result = buildStatusCard(session);
    expect(result).toContain("jarvis-1745123456");
    expect(result).toContain("~/projects/my-app");
    expect(result).toContain("📋 Plan");
    expect(result).toContain("Running (PID 12345)");
    expect(result).toContain("https://claude.ai/code?session=abc123");
  });

  test("session without specPath or sessionUrl → card without spec/url lines", () => {
    const session: RemoteSession = {
      name: "jarvis-1",
      pid: 100,
      dir: "/tmp/project",
      startedAt: new Date().toISOString(),
      chatId: -1,
      threadId: null,
    };
    const result = buildStatusCard(session);
    expect(result).toContain("jarvis-1");
    expect(result).not.toContain("Spec:");
    expect(result).not.toContain("URL:");
  });

  test("unknown permissionMode → shows raw value", () => {
    const session: RemoteSession = {
      name: "jarvis-2",
      pid: 200,
      dir: "/tmp",
      permissionMode: "custom-mode",
      startedAt: new Date().toISOString(),
      chatId: -1,
      threadId: null,
    };
    const result = buildStatusCard(session);
    expect(result).toContain("custom-mode");
  });
});
