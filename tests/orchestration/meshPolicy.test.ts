import { describe, test, expect } from "bun:test";
import { canCommunicateDirect, MESH_LINKS } from "../../src/orchestration/meshPolicy";

describe("meshPolicy", () => {
  test("command-center can talk to research-analyst", () => {
    expect(canCommunicateDirect("command-center", "research-analyst")).toBe(true);
  });

  test("research-analyst can talk to command-center (bidirectional)", () => {
    expect(canCommunicateDirect("research-analyst", "command-center")).toBe(true);
  });

  test("command-center can talk to engineering (executor)", () => {
    expect(canCommunicateDirect("command-center", "engineering")).toBe(true);
  });

  test("command-center can talk to cloud-architect (executor)", () => {
    expect(canCommunicateDirect("command-center", "cloud-architect")).toBe(true);
  });

  test("engineering can talk to code-quality-coach (executor↔reviewer)", () => {
    expect(canCommunicateDirect("engineering", "code-quality-coach")).toBe(true);
  });

  test("engineering can talk to security-compliance (executor↔reviewer)", () => {
    expect(canCommunicateDirect("engineering", "security-compliance")).toBe(true);
  });

  test("code-quality-coach can talk to strategy-comms (reviewer↔critic)", () => {
    expect(canCommunicateDirect("code-quality-coach", "strategy-comms")).toBe(true);
  });

  test("research-analyst CANNOT talk directly to engineering", () => {
    expect(canCommunicateDirect("research-analyst", "engineering")).toBe(false);
  });

  test("operations-hub CANNOT talk directly to security-compliance", () => {
    expect(canCommunicateDirect("operations-hub", "security-compliance")).toBe(false);
  });

  test("unknown agents return false", () => {
    expect(canCommunicateDirect("nonexistent", "command-center")).toBe(false);
  });

  test("MESH_LINKS is a frozen array", () => {
    expect(Object.isFrozen(MESH_LINKS)).toBe(true);
  });
});
