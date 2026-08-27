# Mission Control – Design Spec

*Date: 2026-08-21 · Status: draft for review · 
---

## 1. Problem

the user runs 12+ simultaneous Claude Code sessions across dozens of project directories. The desktop app
gives no fleet-level view. To answer “what is session 7 doing and why did I start it,” he has to
open the session and read backwards. That backtracking cost is the binding constraint on how many
sessions he can actually run.

Four related gaps, in his words and priority order:

1. **No mission control.** No single place showing what is running, what each session is *for*, its
   most recent request, and its most recent deliverable.
2. **No cross-project view.** Each session is an island.
3. **No model control.** Model choice is a session-level setting, not a per-task routing decision.
4. **Cannot shape the surface.** No way to add his own panels or views.
5. **Cannot run unattended.** Work happens only while he is present.

## 2. Verified constraints

Every claim below was checked on this machine on 2026-08-21, not recalled. Commands and results are
recorded so a reviewer can re-run them.

| Claim | Command | Result |
|---|---|---|
| Headless CLI runs on subscription auth, no API key | `claude -p "Reply with exactly: OK" --model claude-haiku-4-5-20251001` | `OK` |
| No `ANTHROPIC_API_KEY` in environment | `[ -n "$ANTHROPIC_API_KEY" ]` | unset |
| Model is selectable per run | `--model` flag on the above | honored |
| Sessions are resumable by ID from CLI | `claude --help` | `-r, --resume [value]`, `--fork-session`, `--session-id <uuid>`, `--from-pr` |
| Headless runs **cannot** see desktop session tools | `claude -p "List tools whose name contains 'session'"` | `NONE` |
| Desktop registers a URL scheme | `plutil -extract CFBundleURLTypes … /Applications/Claude.app` | `CFBundleURLSchemes: ["claude"]` |
| ~~Transcripts are local JSONL~~ **superseded, see §12** | `find ~/.claude/projects -name '*.jsonl' \| wc -l` | 1,945 – **this is a file count, not a session count, and using it as one was an error** |
| Sessions are depth 2 with a UUID basename | `find ~/.claude/projects -mindepth 2 -maxdepth 2 -name '*.jsonl' \| wc -l` | **188** |
| Project directories | `ls ~/.claude/projects \| wc -l` | 99 |
| SQLite needs no native dependency | `node -e "require('node:sqlite')"` on Node v25.8.1 | works |
| Port is free | `lsof -i :4747` | free |

Two consequences drive the whole architecture:

- **The board must read JSONL off disk and drive sessions through the CLI.** The `ccd_session_mgmt`
  tools are injected by the desktop app into interactive sessions only. A local server cannot call
  them. This is confirmed, not assumed.
- **No API key is needed anywhere.** Enrichment, reviewers, and dispatch all shell out to `claude
  -p`, which uses the user’s existing subscription auth.

## 3. Non-goals

- Not a Claude Code replacement. The desktop app stays the place deep work happens.
- Not multi-user, not hosted, not authenticated. Localhost only, bound to `127.0.0.1`.
- Not a general IDE. No file tree, no editor, no terminal emulator.
- No non-Claude model providers in v1. The routing seam allows them later; nothing depends on it.

## 4. Architecture

Two halves in one git repo. They ship together and are useful separately.

```
mission-control/
├── plugin/                  installs into ~/.claude – makes sessions legible
│   ├── hooks/               SessionStart, UserPromptSubmit, Stop, SessionEnd
│   ├── agents/              reviewer roster with pinned models
│   ├── skills/              routing rules, review panel
│   └── install.sh           symlink + backup + uninstall
├── cockpit/                 local Next.js app – makes sessions controllable
│   ├── app/                 board UI + API routes
│   ├── lib/                 indexer, JSONL parser, registry reader, dispatcher
│   └── data/                fleet.db (gitignored)
└── docs/
```

Data flows in one direction into the index, and commands flow out through the CLI.

```
 hooks ──write──► ~/.claude/mission-control/registry/<sessionId>.json  ─┐
                                                                        ├─► indexer ──► fleet.db ──► SSE ──► board
 claude ─append─► ~/.claude/projects/<proj>/<sessionId>.jsonl          ─┘                                      │
                                                                                                               │
 board ──POST──► dispatcher ──spawn──► `claude -r <id> -p …` / `claude -p …` ◄──────────────────────────────────┘
```

### 4.1 State channel: hooks

Four hooks, each a single Node script under 50 lines. Each writes one JSON file and exits. No
network, no model calls, no dependencies beyond `node:fs`.

| Hook | Writes | Why |
|---|---|---|
| `SessionStart` | sessionId, cwd, project, branch, startedAt, model, transcript path | Establishes identity before any content exists |
| `UserPromptSubmit` | status `running`, `lastPrompt`, `lastPromptAt`; first prompt also stored as `seedPurpose` | Exact running state, and a free provisional purpose |
| `Stop` | status `idle`, `idleSince` | Exact idle state without polling heuristics |
| `SessionEnd` | status `ended`, `endedAt` | Distinguishes finished from merely quiet |

**Why hooks rather than inferring from file mtime.** mtime tells you a file changed, not whether
Claude is mid-turn or waiting on the user. “Waiting on you” is the single most valuable cell on the
board, and only the hooks know it exactly.

**Failure policy.** Every hook body is wrapped so the process always exits 0, with a hard 2-second
self-timeout and errors appended to `~/.claude/mission-control/hook-errors.log`. A hook that throws
must never block a session. This is load-bearing: these run in all 99 project directories.

### 4.2 Content channel: indexer

A watcher scans `~/.claude/projects/**/*.jsonl` for files with mtime newer than the last indexed
offset, then reads **only the bytes appended since that offset**. Full re-reads never happen in
steady state.

Per session it extracts: first user message, last user message, last assistant text, last tool used,
message count, model(s) seen, and cumulative token counts where present.

Storage is `cockpit/data/fleet.db` via `node:sqlite` (built into Node 25, no native build).

The JSONL schema is an undocumented internal. The parser therefore:
- treats every field as optional and every line as independently parseable,
- skips malformed lines and counts them,
- surfaces a “transcript format changed” banner on the board when the skip rate for a file exceeds
  10%, rather than silently showing stale data.

### 4.3 Enrichment: purpose and deliverable

Titles say what, never why. Enrichment fills that in.

For each session whose byte offset advanced since its last enrichment, and at most once per 120
seconds per session, the enricher runs one `claude -p --model claude-haiku-4-5-20251001` call over
the recent turns and gets back strict JSON:

```json
{
  "purpose":     "one line: why this session exists",
  "currentState":"one line: what it is doing right now",
  "deliverable": "one line: most recent concrete output (PR, file, finding) or null",
  "blockedOn":   "one line or null",
  "needsAttention":   true
}
```

Bounds, so this never runs away overnight:
- only sessions active in the last 24 hours,
- byte-offset change detection – an unchanged session costs zero,
- 120-second per-session debounce,
- at most 4 concurrent enrichment calls,
- the enricher runs only while the cockpit is running, and is off by default.

`seedPurpose` from the hook is shown immediately, so a card is never blank while waiting on Haiku.

### 4.4 Control channel: dispatcher

Two operations.

**Continue an existing session.** `POST /api/sessions/:id/continue` spawns:

```
claude -r <sessionId> -p "<message>" --output-format stream-json --model <resolved>
```

with `cwd` set to the session’s recorded directory. Output streams back to the card.

**The two-writer guard.** If the registry says a session is `running`, or its transcript grew within
the last 90 seconds, the endpoint returns 409 and the card offers a jump link instead of racing the
transcript. the user chose “continue it headless, watch it land,” and this guard is what makes that safe
rather than corrupting. A `--fork-session` escape hatch is offered on the 409 response.

**Dispatch new work.** `POST /api/dispatch` takes `{project, ask}`. The router resolves a model and
a working mode from `routing.yaml`, then spawns `claude -p --session-id <uuid>` in that project.
the user chose “project plus ask, route the rest,” so the form is two fields.

### 4.5 Routing

`plugin/routing.yaml`, plain and editable:

```yaml
default: claude-sonnet-5
rules:
  - match: {intent: [search, scan, index, summarize, triage]}
    model: claude-haiku-4-5-20251001
  - match: {intent: [plan, spec, review, architecture, decide]}
    model: claude-opus-5
    reviewers: 3
  - match: {intent: [build, fix, refactor, test]}
    model: claude-sonnet-5
    worktree: true
  - match: {intent: [draft, write, voice]}
    model: claude-fable-5
```

Intent is classified by one Haiku call at dispatch time. A wrong classification costs one tier, not
correctness, and the resolved model is always shown on the card before the run starts.

### 4.6 Reviewer panel

the user’s standing rule: every plan, spec, or implementation plan gets exactly three independent
reviewers before it reaches him. He chose automatic enforcement.

A `PostToolUse` hook on `Write`/`Edit` flags the session when the written path matches
`**/specs/**`, `**/*-design.md`, `**/*-plan.md`, or `docs/plans/**`. The card enters
`awaiting-review`. The cockpit then dispatches three headless reviewers, briefed cold, each with a
distinct lens and a distinct model, and shows consolidated findings on the card.

Default lenses: (1) data-model and extensibility lock-in, (2) operational and failure-mode risk,
(3) simpler-alternative and scope. Each reviewer must state **how it would have known if its
conclusion were wrong** – the user’s “a check that cannot fail is not evidence” rule, applied to the
reviewers themselves.

## 5. Board UI

One page. Cards grouped by project, sorted by last activity, anything older than 30 days collapsed.

Each card shows: project and branch · status dot (running / waiting on you / idle / ended) · purpose
· current state · last deliverable · PR number and state where one exists · resolved model · a
compose box.

Sort priority puts **waiting on you** at the top, because that is the state that costs the user time.

Live updates arrive over SSE from the indexer. No polling from the browser.

## 6. Error handling and degradation

The system is reading undocumented internals, so every layer degrades rather than fails.

| Failure | Behavior |
|---|---|
| JSONL schema changes | Malformed lines skipped and counted; banner at >10% skip rate; hook-sourced state still renders |
| A hook throws | Exits 0 anyway; error logged; card falls back to mtime-derived status |
| Haiku enrichment fails or times out | Card shows `seedPurpose` and last raw prompt; retried on next change |
| `claude -r` exits non-zero | stderr shown on the card; transcript untouched |
| Session open in desktop | 409 with jump link; never a silent race |
| `fleet.db` corrupt | Deleted and rebuilt from JSONL; the DB is a cache, never a source of truth |
| Cockpit not running | Hooks keep writing registry files; no session is ever affected |

`fleet.db` holding no authoritative state is deliberate. Everything can be reconstructed from
`~/.claude`.

## 7. Safety

- Server binds `127.0.0.1` only. No auth, because nothing off-host can reach it.
- `install.sh` backs up `settings.json` to `settings.json.bak.<timestamp>` before touching it,
  installs by symlink, and ships `uninstall.sh` that restores the backup and removes the symlinks.
- Hooks are additive. Existing `statusLine` and plugin config are left as they are.
- Dispatch runs inherit Claude Code’s normal permission model. Mission Control does not grant
  permissions and does not pass `--dangerously-skip-permissions`.
- Nothing leaves the machine. No telemetry, no remote writes.

## 8. Testing

- **Parser:** fixture JSONL files including truncated lines, unknown event types, and empty files.
  A mutation check confirms the parser actually fails when fed a broken fixture – a green parser
  test that cannot fail is not evidence.
- **Hooks:** invoked directly with sample payloads; asserted to exit 0 even when handed malformed
  input and an unwritable target directory.
- **Two-writer guard:** a test asserts 409 when the registry says `running`, and asserts the
  transcript byte length is unchanged after the refused call.
- **Indexer:** incremental read asserted to consume only appended bytes, by appending to a fixture
  and checking the read offset.
- **Smoke:** one end-to-end test that dispatches a trivial `claude -p` run and asserts the card
  reaches `idle` with a non-null deliverable.

## 9. Build phases

The MVP line is phase 3. Phases 4 and 5 land behind it.

1. **Index and read-only board.** Parser, indexer, SQLite, SSE, cards from JSONL alone. Proves the
   data before anything depends on it.
2. **Hooks and purpose.** Registry, install script, exact status, Haiku enrichment.
3. **Console.** Continue with the two-writer guard, dispatch, streaming output. ← MVP
4. **Routing and reviewer panel.**
5. **Self-extension.** A command that scaffolds a new panel plus API route into the repo.

## 10. Self-extension

The repo is the product. Adding a feature means asking Claude in a session opened on this repo; the
panel and its API route are written, `next dev` hot-reloads, and the change is git-tracked so
reverting is `git revert <sha>`. No plugin API, no registry, no dynamic loading – the extension
mechanism is the repo plus hot reload, which is the smallest thing that actually works.

## 12. Revisions after independent review (2026-08-21, same day)

Three reviewers were briefed cold on distinct lenses. They found four blocking defects and two of
my stated facts were wrong. Sections above are left intact as the audit trail; where this section
disagrees with them, **this section wins**.

### 12.1 Facts I got wrong

| Claimed above | Actually |
|---|---|
| "1,945 transcripts" | 1,945 is a **file** count. Sessions are depth-2 with a UUID basename: **188** at time of writing. The other ~1,800 are `<sid>/subagents/**` and foreign schemas with no `sessionId`. Globbing `**/*.jsonl` renders ~1,800 phantom cards. |
| §4.2 "extract first/last user message" | **92.6%** of `type:"user"` events (7,113 of 7,678 over 7 days) are tool results with no `promptSource`. The headline column would show git diffs. The real prompt is its own event: `type:"last-prompt"` → `{lastPrompt, leafUuid, sessionId}`. |
| §6 "banner when malformed-line rate exceeds 10%" | **Zero** unparseable lines in 107,730. Drift ships as a *new valid type* or a renamed field, both of which parse fine. The detector watched a channel that has never carried a signal. Replaced by an unknown-type / unknown-key counter that banners on **first sighting**, plus a `.version` tripwire. |
| §4.1 "SessionStart writes branch and model" | The payload contains neither. `gitBranch` is on every user/assistant JSONL event; model is `.message.model`. |
| §3 "the routing seam allows other providers later" | No seam exists — `model:` is a bare string and the dispatcher hardcodes the Claude CLI. Aspirational, not v1. |

### 12.2 Cut from v1: all hooks

`~/.claude/sessions/<pid>.json` already exists and is authoritative, maintained by Claude Code itself:

```json
{"pid": 12345,"sessionId":"411e7d1f-…","cwd":"…","startedAt": 1700000000000,
 "procStart":"Sat Aug 22 03:39:22 2026","version":"2.1.222","kind":"interactive",
 "entrypoint":"claude-desktop","name":"example-project-a1"}
```

That is everything `SessionStart` and `SessionEnd` were going to write, plus ground-truth liveness
via `kill -0` with `procStart` disambiguating PID reuse — at **zero blast radius**. Combined with
`claude agents --json --all`, no hook is needed to know what is alive.

`Stop` is cut too, for a separate reason: subagents fire the parent's hooks **with the parent's
`session_id`**. One measured turn produced `SessionStart → UserPromptSubmit → Stop → UserPromptSubmit
→ Stop → SessionEnd`. Writing `status: idle` on every `Stop` flips the registry mid-turn, corrupting
the one cell the board exists to show.

Measured cost of getting this wrong: a `SessionStart` hook sleeping 30 s made a session take **42.6 s**
instead of 9.4 s. It blocks, and the documented default timeout is **600 s**, not something short.

**v1 installs nothing into `~/.claude`.** Hooks return only if PID + mtime provably fails to
distinguish "waiting on you", and then only `Stop`, with `"timeout": 2` set explicitly.

### 12.3 Cut from v1: the enrichment daemon

`claude -p` **writes its own transcript into `~/.claude/projects/`**, which is the directory the
indexer watches. Enricher output is therefore indexer input. Both variants run away: per-target-cwd
mints a new session per call, and fixed-cwd grows one file that changes every ~10 s and re-triggers
every 120 s forever, ~720 calls/day with zero real sessions. The bounds in §4.3 set the *rate*, not
the total.

It is also unnecessary. `custom-title`, `last-prompt`, and the last `assistant` text give purpose,
most recent request, and deliverable with **no model call at all**.

If enrichment returns, it must run under one reserved `--session-id` excluded from the index, with an
absolute daily call ceiling, and a fixed input window (transcript p90 is 3.5 MB — a naive tail is
~15k input tokens per call).

### 12.4 Changed, not cut: the two-writer guard

The behavior the user chose is unchanged. **My detection mechanism was wrong and would have lost work.**

Two concurrent `claude -r` calls against one session both succeeded — no lock, no error, no warning.
The transcript gained a `parentUuid` with two children, and resuming afterwards showed one branch had
silently vanished from the conversation. The file still parses and the board would render it fine.

Worse, the §4.4 guard was anti-correlated with safety: `idle` means Claude finished and the user is
*reading*, which is exactly the moment he is about to type.

Replacement guard, in order:
1. Resolve the session's PID from `~/.claude/sessions/` and `claude agents --json`; `kill -0` it.
   A live PID is a hard refusal with the `claude://resume?session=<id>` jump link.
2. Record transcript byte length, then **re-check it immediately before spawn** and abort on mismatch.
3. If either check is unavailable, default to `--fork-session` rather than writing.

The §8 test is also replaced: asserting 409 when the registry says `running` cannot fail on the real
bug, which happens when the registry says `idle` and is wrong. The test now fires a headless `-r` at
a live session and asserts **no `parentUuid` has more than one child**. That test can fail — the
reviewer's did.

### 12.5 Recovery, written for a non-developer

`RECOVERY.md` ships with two literal paste-able lines that work even with the repo deleted, and the
board footer prints both. Since v1 installs no hooks, the first is a belt-and-braces no-op today.

### 12.6 Accepted as-is

Byte-offset append-only resumption was independently confirmed correct for the common path (66,620-byte
prefix md5-identical after a resume; file grew in place, no new file). It is moot anyway — measured
tail-read of the full corpus is **485 ms** and a 7-day window is **6 ms**, so §4.2's SQLite index,
incremental offsets, and indexer daemon are all cut. `.message.usage` is present on every assistant
event sampled, so §11's token-count deferral was over-cautious; only *pricing* is unknown.

## 11. Open items

- The exact `claude://` URL path for opening a specific session is unprobed. Until it is confirmed,
  “jump to session” copies the session ID and opens the app. Non-blocking.
- Token and cost figures in the JSONL are not yet confirmed to be present on every event type. Cost
  display is deferred to a later phase rather than shown as a possibly wrong number.
