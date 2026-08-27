# claude-session-cockpit

A local board over your Claude Code sessions: what each one is for, what it last did, and whether it
is stuck – without opening any of them. Runs on `127.0.0.1:4747`, reads the files Claude Code already
writes, and writes nothing back into them.

Useful once you are running more sessions than you can hold in your head. Below about three, the
window switcher is fine.

## What you see

Cards grouped by repository. Sessions inside a `.claude/worktrees/…` folder are grouped under their
real repo rather than scattered as separate projects.

Each card answers three questions: **what is this for** (title and your most recent request), **what
did it last do** (its most recent output), and **is it stuck**:

| Pill | Means |
|---|---|
| **waiting** | Finished, waiting on you. Sorted to the top, because this is the state that costs you time. |
| **working** | Mid-turn right now, or its background agent is. Leave it alone. |
| **stalled** | Started a tool and never came back. |
| **done** | No longer running. |
| **unknown** | Not enough on disk to say. Shown as unknown rather than guessed. |

The window selector (24h / 7d / 30d) sets how far back it looks. You can type into a card to continue
a session, and "Open it in Claude" jumps to that session in the desktop app.

## The two halves

```
cockpit/    the local Next.js board - makes sessions legible and drivable
plugin/     optional install into ~/.claude - hooks and routing that make sessions
            report more precisely than mtime can
docs/       the design spec, including what was cut and why
```

They ship together and work apart: the plugin is useful without the board, and the board degrades to
mtime-derived status without the plugin.

## Run it

```bash
cd path/to/claude-session-cockpit/cockpit
npm install
npm run dev      # http://127.0.0.1:4747
npm test         # no network; skips the live block that would read your own ~/.claude
                 # (MC_RUN_LIVE=1 opts into that one)
```

## What it touches

**Reads** `~/.claude/projects/`, `~/.claude/sessions/`, and `claude agents --json`.
**Writes** only inside its own folder.
**Runs** `claude` when you type into a card, under your normal permission settings.

It installs nothing into `~/.claude` unless you run the plugin installer, binds to `127.0.0.1`, refuses
any request that is not same-origin (loopback alone would not stop a page in your browser posting to
it), and needs no API key – it runs on your existing subscription.

## What v1 deliberately does not do

Cut on purpose, each for a reason worth keeping:

- **No hooks by default.** An earlier design installed four hooks into `~/.claude/settings.json`,
  which is live for every project directory on the machine. Everything they would have recorded is
  already in the session files. A slow hook also delays every session it fires in – a test hook
  sleeping 30 seconds took one session from 9.4s to 42.6s.
- **No background model calls.** An earlier design had a daemon summarising sessions with a small
  model. It would have fed itself: `claude -p` writes its own transcript into the directory the
  board reads.

## A caution about what is on screen

This board renders the contents of your sessions – prompts, tool output, file paths, whatever your
transcripts contain. That is the point of it, and it means the window is as sensitive as your work
is. Keep it on localhost, and think before you screen-share it.

`docs/design-spec.md` has the full architecture and the schema notes in `cockpit/lib/SCHEMA-NOTES.md`
document the transcript format this depends on, which is undocumented and changes between Claude Code
releases. Re-verify after an update.
