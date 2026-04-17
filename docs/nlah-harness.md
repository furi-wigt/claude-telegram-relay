# NLAH Harness — Command Center Orchestration

The NLAH (Natural Language Agent Harness) is the orchestration layer powering the **Jarvis Command Center** group. It replaces the former blackboard/mesh system with a thin event loop: intent classification → contract lookup → sequential dispatch → CC thread audit.

---

## How It Works

```
User message (CC group)
  │
  ├─ intentClassifier.ts   — classify intent + confidence via local model (~200ms)
  │
  ├─ commandCenter.ts      — show inline keyboard: "Route to <agent>? [Confirm] [Cancel]"
  │   └─ (compound) show task list with agents before confirming
  │
  ├─ contractLoader.ts     — load ~/.claude-relay/contracts/<intent>.md
  │
  └─ harness.ts            — execute steps sequentially
        ├─ step 1: dispatchEngine → agent group → collect response → post to CC thread
        ├─ step 2: (compound only) same for next agent
        └─ state written to ~/.claude-relay/harness/state/{dispatchId}.json
```

---

## Contracts

A contract is a Markdown file in `~/.claude-relay/contracts/` that defines which agents handle a task type and what to instruct each one.

### Format

```markdown
---
intent: security-audit
agents: [security-compliance, engineering]
output: security runbook
---
# Security Audit

IM8 compliance check, threat model, and code-level security scan.

## Steps
1. **security-compliance** — threat model, IM8 v4 checklist, PDPA considerations
2. **engineering** — dependency vulnerability scan, code-level security issues

## Context Injection
Include: project name, component/service scope, prior IM8 findings if available
```

### Fields

| Field | Required | Description |
|---|---|---|
| `intent` | Yes | Matches the classifier output (e.g. `security-audit`, `code-review`) |
| `agents` | No | Derived from `## Steps` if omitted |
| `output` | No | Describes the expected artifact (shown in CC confirmation) |
| `## Steps` | Yes | Numbered list of `agent-id — instruction` pairs |
| `## Context Injection` | No | Hint for what context to include in the dispatch message |

### Step Syntax

Two supported formats:

```markdown
1. **agent-id** — instruction text
1. agent-id: instruction text
```

`agent-id` must match an entry in `config/agents.json` (e.g. `engineering`, `security-compliance`, `cloud-architect`).

---

## Built-in Contracts

| File | Intent | Agents | Type |
|---|---|---|---|
| `architecture.md` | `architecture` | cloud-architect | Single |
| `code-review.md` | `code-review` | engineering | Single |
| `research.md` | `research` | strategy-comms | Single |
| `security-audit.md` | `security-audit` | security-compliance → engineering | Compound |
| `default.md` | `default` | operations-hub | Single (fallback) |

---

## Customising Contracts

Edit or create files directly in `~/.claude-relay/contracts/`. Changes take effect immediately — no restart needed.

**Add a new contract:**

```bash
cat > ~/.claude-relay/contracts/compliance-review.md << 'EOF'
---
intent: compliance-review
agents: [security-compliance]
output: compliance gap report
---
# Compliance Review

## Steps
1. **security-compliance** — check IM8 v4 controls, identify gaps, produce remediation list
EOF
```

**Add a compound contract:**

```markdown
---
intent: pr-review
agents: [engineering, security-compliance]
output: review report + security notes
---
# PR Review

## Steps
1. **engineering** — code quality, TDD coverage, refactoring suggestions
2. **security-compliance** — security issues, OWASP checks, dependency audit
```

---

## Dispatch State

After each step, the harness writes a state file:

```
~/.claude-relay/harness/state/{dispatchId}.json
```

```json
{
  "dispatchId": "d-1713412800-abc",
  "userMessage": "Review this PR for security issues",
  "contractFile": "security-audit",
  "steps": [
    { "seq": 1, "agent": "security-compliance", "status": "done", "output": "...", "durationMs": 8200 },
    { "seq": 2, "agent": "engineering", "status": "done", "output": "...", "durationMs": 6100 }
  ],
  "status": "done",
  "createdAt": "2026-04-18T06:00:00.000Z",
  "updatedAt": "2026-04-18T06:02:30.000Z"
}
```

State files are audit-only — a write failure never blocks dispatch.

---

## Key Files

| File | Purpose |
|---|---|
| `src/orchestration/harness.ts` | Main event loop: load contract → execute steps → post to CC |
| `src/orchestration/contractLoader.ts` | Parse `~/.claude-relay/contracts/<intent>.md` |
| `src/orchestration/commandCenter.ts` | CC group handler: confirm routing, show inline keyboard |
| `src/orchestration/dispatchEngine.ts` | Send task to agent group, stream and collect response |
| `src/orchestration/intentClassifier.ts` | Classify free-text → intent + confidence |
| `src/orchestration/interruptProtocol.ts` | Handle `/cancel` mid-dispatch |
