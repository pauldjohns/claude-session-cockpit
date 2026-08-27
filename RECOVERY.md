# If Mission Control misbehaves

Two commands. Copy the whole line, paste it into Terminal, press Return.
They work even if this repo has been deleted, and they need nothing installed.

## 1. Stop the board

```bash
pkill -f "mission-control" ; pkill -f "next dev --turbopack -H 127.0.0.1 -p 4747"
```

Nothing else on your Mac matches those, so this only stops the board. Your Claude Code sessions keep
running and are not touched.

## 2. Remove anything this project added to Claude Code

```bash
python3 -c "import json,pathlib;p=pathlib.Path.home()/'.claude/settings.json';d=json.load(p.open());d['hooks'].pop('<EventName>', None)  # remove one event, not all of them;p.write_text(json.dumps(d,indent=2));print('hooks cleared')"
```

**As of v1 this line does nothing, on purpose.** Mission Control installs no hooks and writes
nothing into `~/.claude`. It only reads. The line is here so that if a later version does install
something and it goes wrong, the fix is already written down and does not depend on the repo, on me,
or on you knowing what a hook is.

Claude Code watches `settings.json` and picks up the change immediately. **You do not need to restart
anything, and you do not need to close your sessions.**

## 3. If Claude Code itself is wedged

For a Terminal session:

```bash
claude --safe-mode
```

That starts Claude Code with CLAUDE.md, skills, plugins, hooks, MCP servers, and custom commands all
switched off, which tells you within seconds whether the problem is something configured or something
in Claude Code itself.

The desktop app does not accept command-line flags, so for the desktop app use command 2 above.

## What Mission Control can and cannot do to your machine

It **reads** `~/.claude/projects/`, `~/.claude/sessions/`, and the output of `claude agents --json`.

It **writes** only inside this repo.

It **runs** `claude` as a subprocess when you type into a card or dispatch new work. Those runs use
your normal permission settings. It never passes `--dangerously-skip-permissions`.

It binds to `127.0.0.1` only, so nothing outside this machine can reach it.

## Your own settings backups

Claude Code writes timestamped backups of `~/.claude/settings.json` when it changes them. List what
you have:

```bash
ls -la ~/.claude/settings.json.bak-*
```

To restore one:

```bash
cp ~/.claude/settings.json.bak-<timestamp> ~/.claude/settings.json
```

Nothing in this project creates or removes those backups.
