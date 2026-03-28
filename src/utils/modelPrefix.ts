/**
 * Model prefix resolution for Telegram message routing.
 *
 * Priority chain:
 *   user prefix [O/H/Q]  >  agent defaultModel  >  Sonnet
 */

export const SONNET_MODEL = "claude-sonnet-4-6";
export const OPUS_MODEL   = "claude-opus-4-6";
export const HAIKU_MODEL  = "claude-haiku-4-5-20251001";

/** Sentinel value — routes to callRoutineModel() instead of Claude CLI. */
export const LOCAL_MODEL_TOKEN = "local";

/** Map agent config shorthand → { model, label } */
const AGENT_DEFAULT_MODEL_MAP: Record<string, { model: string; label: string }> = {
  opus:   { model: OPUS_MODEL,        label: "Opus"   },
  sonnet: { model: SONNET_MODEL,      label: "Sonnet" },
  haiku:  { model: HAIKU_MODEL,       label: "Haiku"  },
  local:  { model: LOCAL_MODEL_TOKEN, label: "Qwen"   },
};

export interface ResolvedModel {
  model: string;
  label: string;
  text: string;
}

/**
 * Parse an optional model-selection prefix from user text.
 *
 * Prefixes: `[O]` → Opus, `[H]` → Haiku, `[Q]` → local Qwen.
 * No prefix: use `agentDefault` shorthand, else Sonnet.
 *
 * @param text         - Raw user message text.
 * @param agentDefault - Agent's defaultModel: "opus"|"sonnet"|"haiku"|"local".
 */
export function resolveModelPrefix(text: string, agentDefault?: string): ResolvedModel {
  const m = text.match(/^\[([OHQ])\]\s*/i);
  if (m) {
    const tag = m[1].toUpperCase();
    const stripped = text.slice(m[0].length);
    if (tag === "O") return { model: OPUS_MODEL,        label: "Opus",   text: stripped };
    if (tag === "H") return { model: HAIKU_MODEL,       label: "Haiku",  text: stripped };
    if (tag === "Q") return { model: LOCAL_MODEL_TOKEN, label: "Qwen",   text: stripped };
  }
  const def = agentDefault ? AGENT_DEFAULT_MODEL_MAP[agentDefault.toLowerCase()] : undefined;
  return def
    ? { ...def, text }
    : { model: SONNET_MODEL, label: "Sonnet", text };
}
