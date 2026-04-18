/**
 * Model prefix resolution for Telegram message routing.
 *
 * Priority chain:
 *   per-message [O/H/L] prefix  >  session.sessionModel  >  agent.defaultModel  >  Sonnet
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
  local:  { model: LOCAL_MODEL_TOKEN, label: "Local"  },
};

export interface ResolvedModel {
  model: string;
  label: string;
  text: string;
}

/**
 * Parse an optional model-selection prefix from user text.
 *
 * Prefixes: `[O]` → Opus, `[H]` → Haiku, `[L]` → local LM Studio.
 * No prefix: sessionModel → agentDefault → Sonnet.
 *
 * @param text          - Raw user message text.
 * @param agentDefault  - Agent's defaultModel shorthand: "opus"|"sonnet"|"haiku"|"local".
 * @param sessionModel  - Session-scoped override set by /model command (same shorthand).
 */
export function resolveModelPrefix(text: string, agentDefault?: string, sessionModel?: string): ResolvedModel {
  const m = text.match(/^\[([OHL])\]\s*/i);
  if (m) {
    const tag = m[1].toUpperCase();
    const stripped = text.slice(m[0].length);
    if (tag === "O") return { model: OPUS_MODEL,        label: "Opus",   text: stripped };
    if (tag === "H") return { model: HAIKU_MODEL,       label: "Haiku",  text: stripped };
    if (tag === "L") return { model: LOCAL_MODEL_TOKEN, label: "Local",  text: stripped };
  }
  const effective = sessionModel ?? agentDefault;
  const def = effective ? AGENT_DEFAULT_MODEL_MAP[effective.toLowerCase()] : undefined;
  return def
    ? { ...def, text }
    : { model: SONNET_MODEL, label: "Sonnet", text };
}
