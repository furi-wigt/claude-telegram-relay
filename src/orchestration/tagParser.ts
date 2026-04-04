/**
 * Agent Response Tag Parser
 *
 * Parses structured tags from agent responses to drive blackboard writes
 * and inter-agent communication.
 *
 * Supported tags:
 *   [BOARD: <type>] <content>        — write a board record
 *   [ASK_AGENT: <agentId>] <message> — direct message to a peer agent
 *   [BOARD_SUMMARY: <text>]          — public summary for the blackboard
 *   [CONFIDENCE: <0-1>]              — self-assessed confidence
 *   [DONE_TASK: <seq>]               — mark a task as complete
 */

export interface BoardTag {
  kind: "board";
  recordType: string; // e.g. "finding", "artifact", "decision"
  content: string;
}

export interface AskAgentTag {
  kind: "ask_agent";
  agentId: string;
  message: string;
}

export interface BoardSummaryTag {
  kind: "board_summary";
  text: string;
}

export interface ConfidenceTag {
  kind: "confidence";
  value: number;
}

export interface DoneTaskTag {
  kind: "done_task";
  seq: number;
}

export type ParsedTag = BoardTag | AskAgentTag | BoardSummaryTag | ConfidenceTag | DoneTaskTag;

// Tag patterns — each captures the tag content after the prefix
const TAG_PATTERNS: Array<{ regex: RegExp; parse: (match: RegExpExecArray) => ParsedTag | null }> = [
  {
    // [BOARD: finding] Some evidence text here
    regex: /\[BOARD:\s*(\w+)\]\s*(.+)/,
    parse: (m) => ({ kind: "board", recordType: m[1].toLowerCase(), content: m[2].trim() }),
  },
  {
    // [ASK_AGENT: cloud-architect] What's the cost estimate?
    regex: /\[ASK_AGENT:\s*([\w-]+)\]\s*(.+)/,
    parse: (m) => ({ kind: "ask_agent", agentId: m[1], message: m[2].trim() }),
  },
  {
    // [BOARD_SUMMARY: brief summary of what was done]
    regex: /\[BOARD_SUMMARY:\s*(.+?)\]/,
    parse: (m) => ({ kind: "board_summary", text: m[1].trim() }),
  },
  {
    // [CONFIDENCE: 0.85]
    regex: /\[CONFIDENCE:\s*([\d.]+)\]/,
    parse: (m) => {
      const value = parseFloat(m[1]);
      if (isNaN(value) || value < 0 || value > 1) return null;
      return { kind: "confidence", value };
    },
  },
  {
    // [DONE_TASK: 3]
    regex: /\[DONE_TASK:\s*(\d+)\]/,
    parse: (m) => {
      const seq = parseInt(m[1], 10);
      if (isNaN(seq)) return null;
      return { kind: "done_task", seq };
    },
  },
];

/**
 * Parse all structured tags from an agent response.
 * Returns parsed tags and the response text with tags stripped.
 *
 * O(n * p) where n = lines, p = patterns (5). Effectively O(n).
 */
export function parseTags(response: string): { tags: ParsedTag[]; cleanText: string } {
  const tags: ParsedTag[] = [];
  const lines = response.split("\n");
  const cleanLines: string[] = [];

  for (const line of lines) {
    let matched = false;
    for (const { regex, parse } of TAG_PATTERNS) {
      const m = regex.exec(line);
      if (m) {
        const tag = parse(m);
        if (tag) {
          tags.push(tag);
          matched = true;
          break;
        }
      }
    }
    if (!matched) {
      cleanLines.push(line);
    }
  }

  return { tags, cleanText: cleanLines.join("\n").trim() };
}
