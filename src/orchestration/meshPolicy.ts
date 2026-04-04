/**
 * Mesh Policy
 *
 * Defines which agent pairs may communicate directly (constrained mesh).
 * All other communication goes through the blackboard.
 */

interface MeshLink {
  from: string;
  to: string;
  bidirectional: boolean;
}

/** Static whitelisted mesh links — matches spec Section 3.4 */
export const MESH_LINKS: readonly MeshLink[] = Object.freeze([
  // Planner ↔ Researcher
  { from: "command-center", to: "research-analyst", bidirectional: true },
  // Planner ↔ Executors
  { from: "command-center", to: "engineering", bidirectional: true },
  { from: "command-center", to: "cloud-architect", bidirectional: true },
  { from: "command-center", to: "security-compliance", bidirectional: true },
  { from: "command-center", to: "operations-hub", bidirectional: true },
  { from: "command-center", to: "strategy-comms", bidirectional: true },
  { from: "command-center", to: "documentation-specialist", bidirectional: true },
  // Executor ↔ Reviewer
  { from: "engineering", to: "code-quality-coach", bidirectional: true },
  { from: "cloud-architect", to: "code-quality-coach", bidirectional: true },
  { from: "engineering", to: "security-compliance", bidirectional: true },
  { from: "cloud-architect", to: "security-compliance", bidirectional: true },
  // Reviewer ↔ Critic
  { from: "code-quality-coach", to: "strategy-comms", bidirectional: true },
  { from: "security-compliance", to: "strategy-comms", bidirectional: true },
]);

/** Pre-computed Set for O(1) lookup: "from→to" keys */
const _allowedPairs: Set<string> = new Set();

for (const link of MESH_LINKS) {
  _allowedPairs.add(`${link.from}→${link.to}`);
  if (link.bidirectional) {
    _allowedPairs.add(`${link.to}→${link.from}`);
  }
}

/**
 * Check if two agents are allowed to communicate directly.
 * O(1) — Set.has().
 */
export function canCommunicateDirect(from: string, to: string): boolean {
  return _allowedPairs.has(`${from}→${to}`);
}
