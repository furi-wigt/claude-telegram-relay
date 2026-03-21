# Claude Code Skills — Reference Documentation

**Source**: Official Claude Code documentation (pasted 2026-03-06 00:31 SGT)
**Saved by**: Jarvis relay bot investigation session

---

## What Are Skills?

Skills are reusable capabilities that extend Claude Code. Each skill is a `SKILL.md` file that provides:
1. **YAML frontmatter** — tells Claude when and how to use the skill
2. **Markdown content** — instructions Claude follows when the skill is invoked

The `name` field becomes the `/slash-command`. The `description` helps Claude decide when to load it automatically.

---

## Getting Started

Create a skill file:

```
~/.claude/skills/explain-code/SKILL.md
```

```markdown
---
name: explain-code
description: Explains code with visual diagrams and analogies. Use when explaining how code works, teaching about a codebase, or when the user asks "how does this work?"
---

When explaining code, always include:

1. **Start with an analogy**: Compare the code to something from everyday life
2. **Draw a diagram**: Use ASCII art to show the structure
3. **Walk through step by step**: Explain execution flow
```

Invoke it with `/explain-code` or Claude will load it automatically when relevant.

---

## Skill Scopes

| Scope | Location | When to use |
|-------|----------|-------------|
| **Project** | `.claude/skills/` | Shared with team, checked into repo |
| **Personal** | `~/.claude/skills/` | Cross-project personal skills |
| **Plugin** | Installed via plugin system | Third-party skills |
| **Managed** | System-managed | Built-in skills |

> **Note**: `.md` files from `--add-dir` directories are **not** loaded as skills — only files inside `skills/` subdirectories with the `SKILL.md` filename.

---

## Frontmatter Reference

```yaml
---
name: skill-name                    # Becomes /skill-name slash command
description: "When to use this"     # Claude uses this to auto-discover
disable-model-invocation: false     # true = user-only (not auto-invoked by Claude)
user-invocable: true                # false = Claude-only (hidden from /commands)
allowed-tools:                      # Restrict which tools this skill can use
  - Bash
  - Read
  - Write
model: claude-opus-4-5              # Override model for this skill
context: fork                       # Run in isolated subagent (fork | inline)
agent: Explore                      # Agent type when context: fork
hooks:                              # Lifecycle hooks
  before: setup-script.sh
  after: cleanup-script.sh
---
```

### Frontmatter Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Slash command name (required) |
| `description` | string | Auto-discovery hint for Claude (required) |
| `disable-model-invocation` | bool | `true` = only user can invoke via `/name` |
| `user-invocable` | bool | `false` = Claude auto-uses only, not listed in `/` menu |
| `allowed-tools` | list | Whitelist of tools available to this skill |
| `model` | string | Override model (e.g. `claude-haiku-4-5-20251001`) |
| `context` | string | `fork` = isolated subagent, `inline` = same context |
| `agent` | string | Agent type for `context: fork` (`Explore`, `Plan`, `general-purpose`, or custom) |
| `hooks` | object | Shell scripts to run before/after skill execution |

---

## Invocation Control

### User-only skills (disable auto-invocation)

```yaml
---
name: deploy-prod
description: Deploys to production. Only use when explicitly requested.
disable-model-invocation: true
---
```

Claude will **never** auto-invoke this — only `/deploy-prod` works.

### Claude-only skills (hidden from user menu)

```yaml
---
name: internal-formatter
description: Auto-formats code output. Claude uses this internally.
user-invocable: false
---
```

Not shown in `/` command list but Claude can auto-discover and use it.

### Invocation control table

| `disable-model-invocation` | `user-invocable` | Result |
|---------------------------|-----------------|--------|
| `false` (default) | `true` (default) | User and Claude can both invoke |
| `true` | `true` | User-only via `/name`, Claude cannot auto-use |
| `false` | `false` | Claude auto-uses only, hidden from `/` menu |
| `true` | `false` | Effectively disabled |

---

## String Substitutions

Available inside skill markdown content:

| Substitution | Description |
|-------------|-------------|
| `$ARGUMENTS` | Full argument string passed after `/skill-name` |
| `$ARGUMENTS[0]`, `$ARGUMENTS[1]` | Individual space-separated args |
| `$1`, `$2`, `$N` | Shorthand for `$ARGUMENTS[N-1]` |
| `${CLAUDE_SESSION_ID}` | Current session UUID |
| `${CLAUDE_SKILL_DIR}` | Absolute path to the skill's directory |

**Example:**
```markdown
---
name: search-docs
---

Search the documentation for: $ARGUMENTS

Focus on: $1
Context filter: $2
Session: ${CLAUDE_SESSION_ID}
```

Invoked as: `/search-docs "authentication" "JWT"`

---

## Dynamic Context Injection

Use `` !`command` `` syntax to run shell commands **before** the skill content is sent to Claude. Output is injected inline.

```markdown
---
name: git-status-report
description: Reports git status with context
---

Current branch: !`git branch --show-current`
Recent commits: !`git log --oneline -5`
Uncommitted changes: !`git status --short`

Summarise the above and suggest next steps.
```

The shell commands run at invocation time — Claude sees the evaluated output, not the raw syntax.

---

## Subagent Execution

Run a skill in an isolated subagent (separate context, separate tool permissions):

```yaml
---
name: deep-analysis
description: Performs deep codebase analysis
context: fork
agent: Explore
allowed-tools:
  - Glob
  - Grep
  - Read
---

Perform a comprehensive analysis of the codebase:
1. Map all module dependencies
2. Identify circular dependencies
3. Find unused exports
```

**Agent types for `context: fork`:**
- `Explore` — fast read-only search (Glob, Grep, Read, no edits)
- `Plan` — planning and architecture (no edits)
- `general-purpose` — full tool access
- Custom agent name from `.claude/agents/`

---

## Supporting Files

Skills can bundle multiple files. The `SKILL.md` references them; they're loaded on demand (not all upfront):

```
.claude/skills/pr-summary/
├── SKILL.md           ← Main skill file
├── template.md        ← Referenced in SKILL.md content
├── examples/
│   ├── good-pr.md
│   └── bad-pr.md
└── config.json
```

In `SKILL.md`:
```markdown
Use the template at ${CLAUDE_SKILL_DIR}/template.md.
See examples in ${CLAUDE_SKILL_DIR}/examples/ for reference.
```

Only `SKILL.md` is loaded at context budget time. Supporting files are read lazily via tool calls.

---

## Example: PR Summary Skill

```markdown
---
name: summarize-pr
description: Summarizes a pull request for review. Use when user asks to review or summarize a PR.
context: fork
agent: Explore
allowed-tools:
  - Bash
  - Read
  - Glob
---

Summarize the pull request for branch: !`git branch --show-current`

1. Run `git log main..HEAD --oneline` to list commits
2. Run `git diff main...HEAD --stat` for changed files
3. Read the most significant changed files
4. Write a concise summary covering:
   - **What changed** (2-3 sentences)
   - **Why** (inferred from commit messages and code)
   - **Risk areas** (breaking changes, security, performance)
   - **Suggested reviewers** based on file ownership
```

---

## Restrict Tool Access

Limit which tools a skill can use — important for security-sensitive skills:

```yaml
---
name: read-only-audit
description: Audits code without making any changes
allowed-tools:
  - Glob
  - Grep
  - Read
  - WebFetch
---

Audit the codebase for security issues. Do not modify any files.
```

If a skill attempts to use a tool not in `allowed-tools`, it is blocked.

---

## Pass Arguments

```markdown
---
name: lint-file
description: Lints a specific file
---

Lint the file at path: $1

Rules to apply: $2 (default: all)

Run the linter and fix any issues found.
```

Usage: `/lint-file src/relay.ts strict`

---

## Restrict Claude's Skill Access

In Claude's permission settings, control which skills Claude can use:

```
# Allow all skills
Skill(*)

# Allow specific skill
Skill(explain-code)

# Allow skills matching pattern
Skill(analyze-*)

# Block a skill
!Skill(deploy-prod)
```

---

## Visual Output Pattern

Skills can generate rich HTML visualisations by bundling a Python/JavaScript script:

```
.claude/skills/visualize-deps/
├── SKILL.md
└── generate_viz.py
```

`SKILL.md`:
```markdown
---
name: visualize-deps
description: Generates an interactive dependency graph
---

Analyse the codebase dependencies, then run:
`python ${CLAUDE_SKILL_DIR}/generate_viz.py`

Output the resulting HTML file path to the user.
```

`generate_viz.py` (abbreviated):
```python
import json
import sys

def generate_html(data: dict, output_path: str) -> str:
    nodes = data.get("nodes", [])
    edges = data.get("edges", [])

    html = f"""<!DOCTYPE html>
<html>
<head><title>Dependency Graph</title></head>
<body>
<div id="graph"></div>
<script>
const nodes = {json.dumps(nodes)};
const edges = {json.dumps(edges)};

// Render graph
nodes.forEach(n => {{
  const el = document.createElement('div');
  el.textContent = n.id;
  document.getElementById('graph').appendChild(el);
}});

edges.forEach(e => {{
  const li = document.createElement('li');
  li.appendChild(document.createTextNode(`${{e.source}} → ${{e.target}}`));
  document.getElementById('graph').appendChild(li);
}});
</script>
</body>
</html>"""

    with open(output_path, 'w') as f:
        f.write(html)
    return output_path

if __name__ == "__main__":
    data = json.load(sys.stdin)
    output = generate_html(data, sys.argv[1] if len(sys.argv) > 1 else "output.html")
    print(f"Generated: {output}")
```

---

## Context Budget

Skill **descriptions** are loaded at startup into Claude's context at ~2% of context window (~16,000 chars fallback). Only the `description` field is loaded upfront — the full `SKILL.md` content is loaded lazily when the skill is invoked.

Override the budget limit:
```bash
export SLASH_COMMAND_TOOL_CHAR_BUDGET=32000
```

Keep descriptions concise. Full instructions go in the markdown body.

---

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| Skill not appearing in `/` menu | Wrong filename or location | Must be `SKILL.md` inside a `skills/` subdirectory |
| Skill not auto-invoked | `disable-model-invocation: true` or poor description | Check frontmatter; improve description specificity |
| `--add-dir` files not loading as skills | `--add-dir` injects as context, not skills | Move to `.claude/skills/` instead |
| Supporting files not found | Wrong path | Use `${CLAUDE_SKILL_DIR}/filename` not relative paths |
| Subagent lacks tools | `allowed-tools` too restrictive | Add required tools to the list |
| Dynamic injection not working | Syntax error | Use `` !`command` `` — backtick immediately after `!` |

---

## Related Resources

- Official docs: `claude.ai/docs` → Claude Code → Skills
- Project skills: `.claude/skills/`
- Personal skills: `~/.claude/skills/`
- Permission rules: Claude Code Settings → Permissions
