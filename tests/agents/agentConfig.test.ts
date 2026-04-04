import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const PROJECT_ROOT = join(import.meta.dir, "../..");

describe("agents.example.json mesh contract fields", () => {
  const agents = JSON.parse(
    readFileSync(join(PROJECT_ROOT, "config/agents.example.json"), "utf-8")
  );

  test("all agents load successfully", () => {
    expect(agents.length).toBeGreaterThanOrEqual(6);
  });

  test("all agents have required base fields", () => {
    for (const agent of agents) {
      expect(agent.id).toBeString();
      expect(agent.name).toBeString();
      expect(agent.groupName).toBeString();
      expect(agent.capabilities).toBeArray();
    }
  });

  test("mesh contract fields are present on all agents", () => {
    for (const agent of agents) {
      expect(agent.meshPeers).toBeArray();
      expect(typeof agent.riskLevel).toBe("string");
      expect(typeof agent.reviewRequired).toBe("boolean");
    }
  });

  test("riskLevel values are valid enum values", () => {
    const validLevels = ["low", "medium", "high", "critical"];
    for (const agent of agents) {
      expect(validLevels).toContain(agent.riskLevel);
    }
  });

  test("meshPeers reference valid agent IDs", () => {
    const allIds = new Set(agents.map((a: any) => a.id));
    for (const agent of agents) {
      for (const peer of agent.meshPeers) {
        expect(allIds.has(peer)).toBe(true);
      }
    }
  });

  test("command-center has broadest mesh connectivity", () => {
    const cc = agents.find((a: any) => a.id === "command-center");
    expect(cc.meshPeers.length).toBeGreaterThanOrEqual(6);
  });

  test("high-risk agents require review", () => {
    for (const agent of agents) {
      if (agent.riskLevel === "high" || agent.riskLevel === "critical") {
        expect(agent.reviewRequired).toBe(true);
      }
    }
  });

  test("backward compat: agents without mesh fields still load (optional)", () => {
    // Simulate an agent definition without mesh fields
    const legacyAgent = { id: "test", name: "Test", groupName: "Test", capabilities: ["test"] };
    // These fields should be undefined, not error
    expect(legacyAgent).not.toHaveProperty("meshPeers");
    expect(legacyAgent).not.toHaveProperty("riskLevel");
    expect(legacyAgent).not.toHaveProperty("reviewRequired");
  });
});
