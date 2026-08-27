# Claude Code hooks – contract reference

*Confirmed against official docs (code.claude.com/docs: hooks-guide, hooks, settings-reference) on
2026-08-21, for Claude Code 2.1.228. Re-check after any Claude Code update.*

This is a reference for building Mission Control's hooks. It is not a plan and not a settings file.
Nothing here is applied to `~/.claude/settings.json` except through `plugin/install.sh`.

---

## Registration shape

Three levels of nesting, all required. Flattening it silently breaks the hook.

```json
{
  "hooks": {
    "<EventName>": [
      {
        "matcher": "<ToolName|Alt>",
        "hooks": [
          { "type": "command", "command": "<cmd>", "timeout": 5 }
        ]
      }
    ]
  }
}
```

`timeout` is in **seconds**.

## Events we use, and their payload fields

All events carry `session_id`, `cwd`, `transcript_path`, `hook_event_name`.

| Event | Extra fields we rely on | Matchers |
|---|---|---|
| `SessionStart` | – | `startup`, `resume`, `clear`, `compact`, `fork` |
| `UserPromptSubmit` | `prompt`, `prompt_id`, `permission_mode` | none |
| `Stop` | **`last_assistant_message`**, `prompt_id` | none |
| `SessionEnd` | `reason` (`clear`/`resume`/`logout`/`prompt_input_exit`/`other`) | none |
| `PostToolUse` | `tool_name`, `tool_input`, `tool_output`, `tool_use_id` | tool name regex, e.g. `Edit\|Write` |

**`last_assistant_message` on `Stop` gives us the deliverable text with no model call.** This is the
single most valuable field in the contract and it removes enrichment from the critical path.

**`SessionStart` has no `source` field in the payload** (docs are silent). The startup reason is only
expressible through the matcher, so register one entry per matcher and pass the reason as an
argument on the command line.

## Timeouts – the part that bites

| Hook type | Default timeout |
|---|---|
| `command`, `http`, `mcp_tool` | **600 s** |
| `UserPromptSubmit` (any type) | 30 s |
| `MessageDisplay` | 10 s |
| `prompt` | 30 s |
| `agent` | 60 s |
| **All `SessionEnd` hooks together** | **1.5 s shared budget** |

The 600 s default is the hazard. Every Mission Control hook sets an explicit `timeout` of 5 s or
less, and the `SessionEnd` hook must finish well inside the shared 1.5 s.

## Execution model

Hooks matching the same event **run in parallel**, and Claude Code merges results only after every
one has finished. A slow hook therefore delays the turn it fires on. Ours do one small synchronous
file write and exit.

## Exit codes

| Code | Effect |
|---|---|
| `0` | Proceed. On `SessionStart` / `UserPromptSubmit`, stdout is injected into Claude's context as plain text. |
| `2` | Block the action, stderr carries the reason. Behavior differs per event. `SessionStart` and `Setup` cannot be blocked – stderr is shown and execution continues. |
| other | Non-blocking error; a hook-error notice appears in the transcript and the action proceeds. |

**`Stop` hooks can block a session from stopping, up to 8 consecutive times before Claude Code
overrides them.** This is the largest blast-radius risk in the whole project. The Mission Control
`Stop` hook exits 0 unconditionally, writes nothing to stdout, and its entire body is inside a
catch-all. A `stop_hook_active` field exists for recursion detection; we never block, so we never
need it, but the hook reads it defensively anyway.

Because `SessionStart` cannot be blocked, it is the safest place to put anything that might be slow.
Nothing slow goes in any of them.

## Precedence

Managed policy > `.claude/settings.local.json` > project `.claude/settings.json` > `~/.claude/settings.json`.

Hooks are arrays and **merge additively** – a hook registered globally and one registered in a
project both run. Mission Control registers globally only, so it never shadows a project hook.

## Open / undocumented

- The full per-event table of exit-code-2 behavior is not published. We avoid the question entirely
  by never exiting non-zero.
- Whether a slow hook blocks session *startup* specifically is not stated outright; parallel
  execution plus result merging implies it does. We assume it does.
- There is **no documented external API for enumerating sessions** – no CLI subcommand, and the
  `ccd_session_mgmt` MCP tools are unavailable to headless runs (verified separately). Reading
  `~/.claude/projects/**/*.jsonl` is the only route, and it is an undocumented internal.
