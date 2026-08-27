# Claude Code transcript JSONL — empirical schema notes

These notes were derived by scanning one machine's own ~/.claude/projects. The counts that
or taken from the design spec; every number came from a script, and the scripts are named beside the
numbers. All example records are **redacted** — keys and value shapes only, never values.*

Corpus at time of measurement:

| Metric | Value | Source |
|---|---|---|
| `.jsonl` files under `~/.claude/projects` | N → N (grew mid-run) | recursive walk |
| Total bytes | N (960.7 MB) | `statSync` sum |
| Total records | N | full LF-split parse |
| Full-corpus parse wall clock | 8.8 s (109 MB/s, one thread) | `fullscan.mjs` |
| Writer versions present | `2.1.181` … `2.1.228` (14 distinct) | `version` field |
| **Session transcripts** (see §1) | **155** at final count, 429.7 MB | depth-2 uuid rule |

**The session-file set is not stable.** Over one working session the depth-2 uuid count read 167,
then 177, then 188, then 155. Files are created *and removed* while you watch. Any code that
memoises the file list, or assumes a session it saw once still exists, will be wrong. Re-walking is
cheap (§9); caching the walk is the expensive mistake.

---

## 1. Only ~8 % of the `.jsonl` files are session transcripts

`~/.claude/projects/**/*.jsonl` is roughly 12× too wide a glob.

| Path shape | Files | Bytes | What it is |
|---|---|---|---|
| **`<proj>/<uuid>.jsonl`** | **155** | **429.7 MB** | **the session transcripts** |
| `<proj>/<sid>/subagents/agent-<hex>.jsonl` | 609 | 329.8 MB | one file per subagent run |
| `<proj>/<sid>/subagents/workflows/wf_<id>/agent-<hex>.jsonl` | N | 198.3 MB | subagents inside a workflow |
| `<proj>/<sid>/subagents/workflows/wf_<id>/journal.jsonl` | 97 | 6.8 MB | workflow journals |
| `<proj>/vercel-plugin/skill-injections.jsonl` | 2 | ~0 | plugin log, foreign schema, no `sessionId` |

**The rule: a session is exactly depth 2 with a uuid basename.** `readdir` the root, `readdir` each
project dir, keep files matching `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i`.
Never recurse. Cross-checks:

- 0 depth-2 files failed the uuid test — the allowlist rejects nothing that belongs.
- N files sit at depth ≥ 3 and none of them are sessions.
- Subagent records carry the **parent's** `sessionId`, so including them collides on primary key and
  overwrites the parent's facts with a subagent's.
- Foreign schemas (`journal.jsonl`, `skill-injections.jsonl`) have no `sessionId` at all.

This is an allowlist on the *name*, not include-then-fail-to-parse. `lib/transcript.ts` exports
`isSessionFileName()`; `lib/scan.ts` exports `listSessionFiles()` and counts what it rejected.

**`sessionId` always equals the filename.** Across every main file checked (167 at the time), 0 had
an internal camelCase `sessionId` differing from the basename, and 0 contained more than one.

---

## 2. The killer parsing detail: never use `node:readline`

`node:readline` treats **U+2028 LINE SEPARATOR** and **U+2029 PARAGRAPH SEPARATOR** as line
terminators. Those characters occur inside JSON string values in real transcripts (assistant text
quoting web content). readline shreds one valid record into several invalid fragments.

Same corpus, same files, only the splitter changed:

| Splitter | Records | Malformed | Rate |
|---|---|---|---|
| `node:readline` (`crlfDelay: Infinity`) | N | **17** | 0.0079 % |
| split on `0x0A` only | N | **0** | **0.000000 %** |

Reproduction (`crtest.mjs`), one subagent file: readline yields 222 lines / 15 malformed. The file
contains 210 LF bytes, **0 CR bytes**, 6 × U+2028 and 6 × U+2029.

**The true malformed-line rate of this corpus is zero.** Every "malformed line" I could produce was
an artifact of the reader. Corpus-wide there are also 0 bare `\r`, 0 `\r\n`, and 0 U+0085/U+000B/U+000C.
Lines are UTF-8, LF-terminated, one JSON object per line.

`lib/transcript.ts` splits on `\n` and never imports readline.

---

## 3. Every `type` value observed (N records, whole tree)

```
assistant             N     user                     N
attachment              N     last-prompt               N
queue-operation         N     custom-title              N
pr-link                 N     system                    N
started                 N     result                      996
mode                      861     permission-mode              36
ai-title                   31     file-history-snapshot        20
agent-name                 10     frame-link                    7
file-history-delta          1     (no `type` key at all)        2
```

`system` splits by `subtype`: `stop_hook_summary` N · `api_error` 411 · `turn_duration` 12 ·
`local_command` 5 · `away_summary` 2 · `informational` 1.

The two records with **no `type` key** are `vercel-plugin/skill-injections.jsonl` lines. Code that
does `String(o.type)` gets the string `"undefined"` for them. The parser treats a missing `type` as
an unknown type and counts it, without throwing.

Restricted to the 155 **session** transcripts (N records), `started`, `result` and
`file-history-*`-heavy shapes thin out, and 15 types remain — that set is what `KNOWN_TYPES` in
`lib/transcript.ts` pins.

### Two record families

**Family A — envelope records** carry the full context:
`parentUuid, isSidechain, type, uuid, timestamp, userType, entrypoint, cwd, sessionId, version,
gitBranch`. Types: `user`, `assistant`, `attachment`, `system`.

**Family B — sidecar records** carry `type`, `sessionId` and little else. **No `timestamp`, no
`cwd`, no `gitBranch`, no `uuid`.** Types: `last-prompt`, `custom-title`, `ai-title`, `mode`,
`permission-mode`, `agent-name`, `started`, `result`. (`queue-operation`, `pr-link`, `frame-link`,
`file-history-*` do carry a `timestamp` but no envelope.)

Two consequences the parser depends on:

- **`cwd` / `gitBranch` must be carried forward**, because the last line of a file is usually a
  Family B record with neither. Last-line types across 167 main files: `last-prompt` 114,
  `pr-link` 17, `mode` 14, `queue-operation` 7, `custom-title` 6, `file-history-snapshot` 4,
  `assistant` 2, `user` 2, `permission-mode` 1.
- **"Last timestamp" is `max(timestamp)`, never "the last line's timestamp."** 133 of 167 main
  files have timestamps that go backwards by more than 2 s at least once. File mtime also runs
  *ahead* of the newest timestamped record in essentially every file (median gap ≈ 9.7 h) because
  untimestamped sidecars keep landing. Sort on `max(mtime, newest timestamp)`; neither alone is
  right.

---

## 4. Where every field the board needs actually lives

| Wanted | Where | Notes |
|---|---|---|
| session id | filename; `sessionId` on records | identical in 167/167; **see §6 on `session_id`** |
| project dir | first path segment under the root | encoded, `/`→`-`, lossy |
| cwd | `cwd` on Family A | absolute; often no longer exists (§8) |
| git branch | `gitBranch` on Family A | empty string outside a repo — no `git` shell-out needed |
| most recent request | **`{"type":"last-prompt","lastPrompt":…}`** | present in **155/155** files. Primary source. |
| user prompt, fallback | filtered `user` records | §5 — not simple, and mostly tool output |
| assistant text | `assistant` → `message.content[]` `type:"text"` → `.text` | |
| thinking | same array, `type:"thinking"` → `.thinking` + `.signature` | excluded from board text |
| tool calls | `assistant` → `content[]` `type:"tool_use"` → `.name`, `.input`, `.id` | N |
| tool results | `user` → `content[]` `type:"tool_result"` | N |
| rich tool result | top-level `toolUseResult` on the `user` record | ~100 distinct key shapes |
| model | `assistant` → `message.model` | filter `<synthetic>` — §7 |
| tokens | `assistant` → `message.usage` | **100 % of assistant records** — §7 |
| timestamps | `timestamp`, ISO-8601 ms UTC | N/N conform; zero other formats |
| message linkage | `uuid` / `parentUuid` | 0 duplicate `uuid` in any file; root has `parentUuid: null` |
| title | `custom-title.customTitle`, else `ai-title.aiTitle` | 103/155 sessions; last one wins; no model call |
| PR | `pr-link` → `prNumber`, `prUrl`, `prRepository` | 106/155 sessions; no `gh` call |
| plan / permission mode | `mode.mode`, `permission-mode.permissionMode` | |
| queued prompts | `queue-operation` → `operation` ∈ {`enqueue`,`dequeue`,`remove`}, `content` | first line of 157/167 files |
| effort | `effort` on `assistant` | `high` N · `xhigh` N · `max` N · `medium` 152 · `low` 106 |
| entrypoint | `entrypoint` | `claude-desktop` N · `cli` 436 · `sdk-cli` 200 |
| attribution | `attributionAgent` / `Skill` / `Plugin` / `McpServer` / `McpTool` | `assistant` only |

### Redacted example records

```jsonc
// assistant, tool_use block — Family A
{ "parentUuid":"<uuid>", "isSidechain":true, "agentId":"<id>",
  "message": { "model":"claude-opus-5", "id":"<id>", "type":"message", "role":"assistant",
    "content":[ { "type":"tool_use", "id":"<id>", "name":"Read",
                  "input":{"file_path":"<string>"}, "caller":{"type":"direct"} } ],
    "stop_reason":"tool_use", "stop_sequence":null, "stop_details":null,
    "usage": { "input_tokens":<n>, "cache_creation_input_tokens":<n>,
               "cache_read_input_tokens":<n>,
               "cache_creation":{"ephemeral_5m_input_tokens":<n>,"ephemeral_1h_input_tokens":<n>},
               "output_tokens":<n>, "service_tier":"standard", "inference_geo":"<string>" },
    "diagnostics":null },
  "requestId":"<id>", "attributionAgent":"<string>", "type":"assistant", "uuid":"<uuid>",
  "timestamp":"<iso8601>", "effort":"max", "userType":"external", "entrypoint":"claude-desktop",
  "cwd":"<path>", "sessionId":"<uuid>", "version":"2.1.222", "gitBranch":"<branch>" }

// user, tool_result — message.content[].content is a string OR an array
{ "parentUuid":"<uuid>", "isSidechain":true, "promptId":"<uuid>", "type":"user",
  "message":{ "role":"user",
    "content":[ {"tool_use_id":"<string>","type":"tool_result","content":"<string>"} ] },
  "toolUseResult":{ "stdout":"<string>","stderr":"<string>","interrupted":false,"isImage":false },
  "uuid":"<uuid>", "timestamp":"<iso8601>", "sourceToolAssistantUUID":"<uuid>", … envelope … }

// user, a real typed prompt — content is a bare string OR an array of text blocks
{ "parentUuid":"<uuid>", "isSidechain":false, "promptId":"<uuid>", "type":"user",
  "message":{ "role":"user", "content":"<string>" },
  "uuid":"<uuid>", "timestamp":"<iso8601>", `"permissionMode": "<mode>"`,
  "origin":{"kind":"human"}, "promptSource":"sdk", … envelope … }

// Family B sidecars — no timestamp, no cwd, no uuid
{ "type":"last-prompt",     "lastPrompt":"<string>", "leafUuid":"<uuid>", "sessionId":"<uuid>" }
{ "type":"custom-title",    "customTitle":"<string>", "sessionId":"<uuid>" }
{ "type":"ai-title",        "aiTitle":"<string>",     "sessionId":"<uuid>" }
{ "type":"mode",            "mode":"normal",          "sessionId":"<uuid>" }
{ "type":"permission-mode", "permissionMode":"auto",  "sessionId":"<uuid>" }
{ "type":"agent-name",      "agentName":"<string>",   "sessionId":"<uuid>" }

// timestamped but not enveloped
{ "type":"pr-link", "sessionId":"<uuid>", "prNumber": 123, "prUrl":"<string>",
  "prRepository":"<string>", "timestamp":"<iso8601>" }
{ "type":"queue-operation", "operation":"enqueue", "timestamp":"<iso8601>",
  "sessionId":"<uuid>", "content":"<string>" }

// system, api_error
{ "type":"system", "subtype":"api_error", "level":"error",
  "error":{"message":"<string>","status":401,"formatted":"<string>","connection":null,
           "isNetworkDown":false,"rateLimits":null},
  "retryInMs":<n>, "retryAttempt":<n>, "maxRetries":<n>, "source":"<string>", … envelope … }
```

---

## 5. "Last user message" is 92 % tool output

Of N `user` records in main transcripts, N are tool results. Taking the newest `user`
record puts a git diff in the board's headline column. Cross-tab (`prompts.mjs`):

| text-shaped | `isMeta` | `origin.kind==="human"` | `promptSource` | count |
|---|---|---|---|---|
| no  | –    | –     | –      | N ← tool results |
| yes | no   | no    | `sdk`  | 975 |
| yes | no   | **yes** | `sdk` | 920 |
| yes | **yes** | no | –      | 210 ← injected documents/text |
| yes | no   | no    | –      | 152 |
| yes | no   | **yes** | `typed` | 10 |
| yes | **yes** | no | `sdk`  | 8 |

**Use `last-prompt`.** It is a verbatim copy of the user's prompt, present in **155/155** sessions,
and it needs no predicate at all. `lib/transcript.ts` treats it as primary and reports
`lastUserMessageSource: 'last-prompt'`.

The fallback predicate, for the case where a `last-prompt` record is not inside the read window:
`type === "user"` **and** `isMeta !== true` **and** `promptSource != null` **and** no `tool_result`
block **and** (`origin.kind === "human"` when `origin` is present) **and** the text does not start
with one of the six machine wrappers observed:
`<task-notification>` 907 · `<local-command-stdout>` 69 · `<command-name>` 70 ·
`<system-reminder>` 26 · `<cross-session-message>` 11 · `<command-message>` 2. Plain human text: 972.

Two caveats worth knowing:

- `origin` and `promptSource` are **newer fields**: only 141 of 177 files carried `origin`
  (`{"kind":"human"}` 930, `{"kind":"task-notification"}` 907), and `promptSource` appears N
  times (`sdk` N, `typed` 10). Requiring `promptSource` would reject every prompt in an older
  file — which is safe only because `last-prompt` covers 100 % of sessions and the fallback is a
  rarity. If `last-prompt` ever disappears, this filter needs revisiting, not tightening.
- The `tool_result` guard is currently **redundant**: 0 of N tool-result records carry
  `promptSource`, and 0 mix a `tool_result` block with any other block type. It is kept as
  defence-in-depth and pinned by a test, because "writer starts tagging tool results" is exactly
  the drift that would put a diff on the board.

---

## 6. `session_id` and `sessionId` both exist and hold different uuids

Writer versions 2.1.220 / 2.1.226 / 2.1.227 added a snake_case `session_id` **alongside** the
camelCase `sessionId`. Across the whole tree:

- 347 records carry **both** spellings; in **4** of them the two values **differ**.
- In every differing case the **camelCase** value matched the filename and the snake_case value did not.
- `session_id` never appears without `sessionId` (0 records).
- It shows up on `assistant` (221), `user` (107) and `attachment` (19) records.

**Pin camelCase `sessionId`. Never case-normalize keys.** A parser that lowercases or
snake/camel-folds its keys silently adopts the wrong identity for a growing share of records.
`lib/transcript.ts` reads `rec.sessionId` only, treats the filename as authoritative, and reports
`sessionIdMismatch` when the two disagree. Pinned by a test with a fixture carrying both spellings.

---

## 7. Models and tokens — the spec's open item #11 is answerable

```
claude-opus-5 N   claude-fable-5 N   claude-opus-4-8 N
claude-sonnet-5  N   claude-haiku-4-5-20251001  139   <synthetic>  132
```

`<synthetic>` is a **real value** on client-generated assistant records (API-error placeholders).
It must be filtered before display; it is not a model.

`message.usage` is present on **N of N** assistant records — 100 %, not "not yet
confirmed to be present on every event type" as spec §11 says:

```
input_tokens N   cache_creation_input_tokens N   cache_read_input_tokens N
output_tokens N  service_tier N   cache_creation N   inference_geo N
server_tool_use N iterations N      speed N    output_tokens_details 188
```

`user` records carry no usage. Per-session token totals are a plain sum over assistant records and
they are complete. The blocker for cost display is a price table, not data availability.

`stop_reason`: `tool_use` N · `null` N · `end_turn` N · `stop_sequence` 132 ·
`max_tokens` 2. **One assistant turn is written as several `assistant` records — one per content
block.** N assistant records produced only N `end_turn`s. Message count is a count of
records, not turns; do not label it "turns".

---

## 8. Mid-turn vs waiting-on-you — the transcript **can** answer this

This is the most valuable cell on the board, and the JSONL does carry the signal.

**The signal is `stop_reason` on the newest `assistant` record.** Across 155 session transcripts
(`turnstate.mjs`), the newest assistant record's `stop_reason` was:

```
end_turn 148   tool_use 5   stop_sequence 1   (no assistant record) 1
```

and it separates cleanly by freshness:

```
fresh (<5 min) stop=tool_use   3      old stop=tool_use    2   ← killed mid-turn
fresh (<5 min) stop=end_turn   5      today stop=end_turn 32   old stop=end_turn 111
```

Corroborating evidence from the last *envelope* record per file:

```
assistant/text:end_turn 141   attachment 5   user/tool_result 2   system/away_summary 2
system/local_command 1   system/turn_duration 1   user/str 1   system/informational 1   user/text 1
```

- `tool_use` → the model asked for a tool and will be re-entered. **Mid-turn.**
  The last envelope record is either the `tool_use` itself (tool still running) or a
  `user`/`tool_result` (result returned, model not yet re-entered).
- `end_turn` / `stop_sequence` / `max_tokens` → the turn completed. **Awaiting the user.**
  A `last-prompt` sidecar follows in 101 of 155 files, which is a second, cheaper confirmation.
- **A human prompt newer than the newest assistant record → mid-turn.** The user has spoken and the
  model has not produced a record yet.

`stop_reason: null` is safe to ignore: **1 of N** assistant records in session transcripts had
it, and it was never the newest one (0/155 files). The parser still carries the newest non-null
value backwards, so a future increase does not break the answer.

**`tool_use` + a stale file = abandoned, not running.** Two live examples: sessions `<session-id>` and
`<session-id>`, both `stop_reason=tool_use` with the tool result already back, untouched for 336 h and
540 h. `lib/scan.ts` splits this into `activity: 'running' | 'stalled'` on file mtime, keeping the
transcript-only verdict in `turnState` and the mtime-weighted one in `activity`.

### The one blind spot: background subagents

**The main transcript cannot see subagent work at all.** `isSidechain: true` appears on N records tree-wide but on **0 records in any main transcript** (0/167 files checked) — all sidechain
content lives in `<sid>/subagents/**`. A session that dispatched a background agent therefore reads
`awaiting-user` while work is very much in flight.

Demonstrated live during this build: session `<session-id>`'s own transcript last moved **207 s** ago
and read `awaiting-user`, while its subagent transcript had been written **1 s** ago.

110 of 155 sessions have a `subagents/` directory. `lib/scan.ts` closes the gap by taking the newest
mtime under `<sid>/subagents/**` and setting `backgroundAgentActive` when it is newer than the
session's own transcript and recent. Cost: 13 ms for all 110 directories; ~4 ms for a 7-day window.
It is an option (`checkSubagents`, default on) so the transcript-only answer stays reachable.

A separate, stronger liveness source exists outside the JSONL — `claude agents --json --all` reports
pids and state directly. The transcript answers *"did the turn end"*; that command answers *"is the
process alive"*. They are complementary, and neither subsumes the other.

---

## 9. Reading strategy: tail window, not byte offsets

### The files are append-only, as far as anything can show

1. **Mutable state is appended, never edited.** 155 session files hold N `last-prompt`, N
   `custom-title`, 863 `mode` and N `queue-operation` records — ~47 `last-prompt` per file. A
   writer that rewrote in place would keep one. Appending and letting the last occurrence win is the
   signature of an append-only log.
2. **No compaction artifacts anywhere.** `grep -rl` over the whole tree for `"type":"summary"`,
   `"isCompactSummary"`, `"compactMetadata"`, `"type":"compact…"`, `"subtype":"compact…"` returns
   **0 files each**. There is no summary record type in any of the 14 writer versions here. The
   spec's §4.2 assumption that compaction is the rewrite risk does not show up in this corpus.
3. **No duplicate `uuid`s** within any file (0/167), which a re-emit-after-rewrite would produce.
4. **`sessionId` never changes within a file** (0/167). Resume and fork produce a *new* file.
5. A snapshot/compare over all N files across this working session (`snapshot.mjs`: sha1 of the
   first 4 KB + size + mtime) recorded **0 files shrank and 0 head fingerprints changed**. Files
   only grew, appeared, or disappeared entirely.

That is enough to make byte-offset resumption *safe*, but it is not enough to make it *worth it* —
and a tail window is immune to the question either way. A window read from the end cannot be
corrupted by a rewrite, so no fingerprinting, no offset table, and no re-parse trigger is needed.

### Window size: 64 KB, chosen from measurement

Miss rate for the two facts that can fall out of a short window, over all 155 sessions:

| tail window | sessions with no recoverable prompt | sessions with no assistant record | bytes read |
|---|---|---|---|
| 8 KB | 5 | 8 | 1.3 MB |
| 16 KB | 5 | 3 | 2.5 MB |
| 32 KB | 3 | 2 | 5.1 MB |
| **64 KB** | **2** | **1** | **10.1 MB** |
| 128 KB | 2 | 1 | 19.5 MB |
| 1024 KB | 2 | 1 | 131.2 MB |

64 KB is the knee. Past it, 16× more bytes buys nothing — the residual 2 sessions have no prompt
record anywhere in reach, not a window that is too small. `tailBytes` is caller-overridable for the
rare case where a card needs more history.

### Partial lines

- **Head.** A window that starts mid-file starts mid-record. Expected, not an error: the parser
  attempts the first fragment, and if it is not a JSON object it is discarded and reported as
  `droppedPartialHead`. It is never counted as malformed.
- **Tail.** If the window does not end on `\n` the writer is mid-append. The parser attempts the
  fragment (a complete record that merely lacked a trailing newline is kept) and otherwise discards
  it as `droppedPartialTail`. Also never counted as malformed.
- A **complete** line that fails to parse *is* counted in `skippedLines`. That counter starts from a
  verified-zero baseline, so any nonzero value on the board is real.

### Performance

| Measurement | Value |
|---|---|
| `readdir` + `stat` of the whole tree | 87 ms (coordinator) / 2–27 ms warm (`scan.ts`) |
| **`scanRecent()` 7-day window — 43 sessions** | **17 ms** median of 9 (13 ms with `checkSubagents:false`) |
| `scanRecent()` all 155 sessions | 60 ms median of 9 (48 ms without subagent checks) |
| Bytes read, 7-day window | 2.77 MB for N records |
| Full parse of the largest single file (27.1 MB, N records) | 145 ms |
| Full parse of all 960 MB | 8.8 s |

Records are enormous relative to their count (27 MB / N records ≈ 19 KB each) because tool
results are inlined and images/documents are base64 in-band — one observed `document` block was
742 KB in a single line, one `image` block 352 KB. Streaming record-by-record and retaining only
clipped facts is required; retaining parsed records is not viable.

---

## 10. Drift detection: watch for new types, not broken JSON

**A malformed-line counter watches a channel that has never carried a signal.** 0 unparseable lines
in N. Format drift arrives as a *new valid type* or a *renamed field*, and a naive
`switch (type)` already ignores ~28 % of records as "not one of the ones I handle".

`lib/transcript.ts` therefore pins three baselines, generated from all 155 session transcripts
(N records, writer versions 2.1.181 – 2.1.228):

- `KNOWN_TYPES` — the 15 record types.
- `KNOWN_KEYS` — the exact top-level key set per type. Recently added keys already in the baseline
  and worth watching: `sessionKind`, `slug`, `session_id`, `errorDetails`, `interruptedMessageId`.
- `KNOWN_VERSIONS` — the 14 writer versions.

Anything outside a baseline is counted **and** recorded as a **first sighting** — the record index,
file and timestamp where it first appeared — not folded into a percentage. `scanRecent()` aggregates
these across the scan and returns `drift.hasDrift`, so the board can show a banner naming the new
type or key rather than "skip rate above threshold".

Practical note: `KNOWN_VERSIONS` fires on every Claude Code upgrade. That is the intent — a version
bump is the moment to re-run `keyset.mjs` and refresh the baselines.

---

## 11. cwd is dead more often than not

Of the sessions in a 7-day window, **28 of 43 have a `cwd` that no longer exists** (106 of 155
across all sessions) — almost entirely cleaned-up `.claude/worktrees/*` checkouts.

`resolveRepoRoot()` walks up past a `.claude/worktrees/<name>` segment, which collapses the fleet
onto something durable:

| Grouping key | 7-day window | all sessions |
|---|---|---|
| `projectDir` (encoded dir) | 28 | 86 |
| `cwd` | 28 | 87 |
| **`repoRoot`** | **6** | **12** |
| `repoRoot` that still exists | 43 of 43 | 155 of 155 |

Grouping by project dir or cwd scatters one repo's work across dozens of dead worktrees. Grouping by
`repoRoot` gives 6 real projects, and every one of those paths still exists. `cwdExists` and
`repoRootExists` are both reported per session so a card can show "worktree gone" honestly.

---

## 12. What should change in the design spec

1. **§2 / §4.2 — file count and glob.** "N `.jsonl` files" counts everything; only ~155 are
   session transcripts. `~/.claude/projects/**/*.jsonl` is wrong; depth-2 with a uuid basename is
   right, and it must be an allowlist on the name.
2. **§4.2 — the whole index premise.** A 7-day scan of the real tree is **17 ms**. The byte-offset
   table, the rewrite fingerprint and the SQLite cache were all solving a problem that measurement
   says does not exist. Read the tail on demand.
3. **§4.2 — malformed-line banner.** The measured baseline is **0.000000 %**, so a >10 % threshold
   is far too slack to warn about anything. Replace the percentage with a *new type / new key / new
   version* first-sighting banner.
4. **§4.2 — compaction.** No summary or compaction record type exists in any of the 14 writer
   versions present. The spec should not name compaction as the known rewrite cause.
5. **§11 — token figures. Resolved.** `message.usage` is on 100 % of assistant records with input,
   output, cache-read and cache-creation counts. Only a price table is missing.
6. **§5 — PR state is free.** `pr-link` gives number, URL and repository directly for 106/155
   sessions. Only *state* (open/merged) needs `gh`.
7. **§4.3 — enrichment has cheaper competition.** `custom-title` / `ai-title` give a title for
   103/155 sessions and `last-prompt` gives the verbatim most recent request for 155/155, both with
   no model call. Haiku enrichment should fill *purpose* and *deliverable*, not title or last prompt.
8. **§4.1 — hooks are less load-bearing for identity than assumed.** Everything `SessionStart`
   would write (sessionId, cwd, project, branch, transcript path) is already on the first Family A
   record. Hooks still earn their place for exact `running`/`idle`, but §8 shows the transcript gets
   most of the way there on its own, and `claude agents --json --all` closes the rest.
9. **§5 — the board needs a `stalled` state.** `tool_use` plus a long-dead file is a real and
   distinct condition (2 sessions here, idle 336 h and 540 h). It is neither running nor waiting on
   the user.
10. **New — group by repo, not by project dir.** 87 distinct cwds collapse to 12 repo roots, and
    68 % of cwds no longer exist.
11. **§8 — the test command does not work.** `node --test tests/` does not discover tests on Node
    v25.8.1: a bare directory positional is resolved as a module and throws `MODULE_NOT_FOUND`.
    It must be a glob — `node --test "tests/**/*.test.ts"` — and `package.json` has been corrected.

---

*Scripts behind every number here live in this session's scratchpad: `fullscan.mjs` (types, keys,
models, usage, tools), `keyset.mjs` (per-type key inventory), `analyze2.mjs` (append-only evidence,
sidechain placement, id match), `prompts.mjs` (human-prompt cross-tab), `mixed.mjs` (tool_result
block shapes), `turnstate.mjs` (mid-turn signal), `idcheck.mjs` (`session_id` vs `sessionId`,
null `stop_reason`), `crtest.mjs` (readline vs LF), `shapes.mjs` (redacted shapes), `snapshot.mjs`
(rewrite watch), `probe.mjs` (tail-window sizing, subagent blind spot).*
