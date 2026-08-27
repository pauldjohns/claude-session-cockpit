/**
 * Spawning Claude Code from the console: continue an existing session, or start a new one.
 *
 * `continueSession` is the dangerous half and every line of it is subordinate to `lib/guard.ts`.
 * Order is load-bearing and is the order in §12.4 of the design:
 *
 *   lock → assertSafeToWrite → resolve a cwd that exists → recheckBytes → spawn
 *
 * `recheckBytes` sits in the statement directly above `spawn`. Anything inserted between them
 * re-opens the window it exists to close.
 *
 * ## Two deviations from the literal command string in the brief, both measured
 *
 * 1. **The prompt goes on stdin, not argv.** `claude`'s prompt is a positional argument, and
 *    commander parses a leading `-` as an option. Verified on 2.1.228:
 *
 *        $ claude -p "--version"
 *        2.1.228 (Claude Code)          ← the prompt became a CLI flag
 *        $ claude -p -- "--version"
 *        `--version` isn't something I can answer …
 *
 *    A message that starts with a dash — a markdown bullet, or something worse — must never be
 *    able to become a flag on a process this module also promises never to hand
 *    `--dangerously-skip-permissions`. `--` fixes the observed case; stdin removes the message
 *    from argv altogether, which is the fix that cannot be argued with. Verified working with
 *    `-r`, `--session-id`, `--output-format stream-json` and `--verbose`.
 * 2. **`--model` is validated against a conservative character class** before it reaches argv,
 *    for the same reason.
 *
 * `--dangerously-skip-permissions` (and its `--allow-` variant) is never passed. Not behind a
 * flag, not behind an option, not ever. In print mode a tool that needs permission simply fails,
 * which is the correct outcome for a console that runs unattended.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';

import {
  acquireSessionLock,
  assertSafeToWrite,
  isSessionId,
  jumpUrlFor,
  recheckBytes,
  type SessionLock,
} from './guard.ts';
import { parseTranscriptTail, resolveRepoRoot } from './transcript.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContinueRefusalReason =
  | 'alive'
  | 'unresolvable'
  | 'missing-transcript'
  | 'missing-cwd'
  | 'transcript-changed'
  | 'busy'
  | 'bad-request'
  | 'spawn-failed';

export type DispatchRefusalReason = 'missing-cwd' | 'bad-request' | 'spawn-failed';

export interface RunHandle {
  /** NDJSON: `claude --output-format stream-json` lines, then one `cockpit_status` line. */
  stream: ReadableStream<Uint8Array>;
  /** OS pid of the spawned `claude`, for the UI and for kill-on-demand later. */
  pid: number;
  cwd: string;
}

export type ContinueResult =
  | ({
      ok: true;
      sessionId: string;
      transcriptPath: string;
      /** Transcript length the run was authorised against. */
      bytes: number;
    } & RunHandle)
  | {
      ok: false;
      sessionId: string;
      reason: ContinueRefusalReason;
      detail: string;
      pid?: number;
      jumpUrl?: string;
    };

export type DispatchResult =
  | ({ ok: true; sessionId: string } & RunHandle)
  | { ok: false; reason: DispatchRefusalReason; detail: string; sessionId?: string };

export interface ContinueInput {
  sessionId: string;
  message: string;
  model?: string;
}

export interface DispatchInput {
  cwd: string;
  prompt: string;
  model?: string;
}

// ---------------------------------------------------------------------------
// Argument hygiene
// ---------------------------------------------------------------------------

/** Model aliases and full names only: `opus`, `haiku`, `claude-fable-5`, … Never a flag. */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function modelArgs(model: string | undefined): string[] | null {
  if (model === undefined || model === null || model === '') return [];
  if (typeof model !== 'string' || !MODEL_RE.test(model)) return null;
  return ['--model', model];
}

function isDirectory(path: string | undefined): path is string {
  if (!path) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

const STDERR_CAP = 8 * 1024;

/**
 * Wrap a child in a web stream of its stdout, terminated by one `cockpit_status` NDJSON line
 * carrying the exit code and any stderr.
 *
 * Cancelling the stream (the browser tab closes) deliberately does **not** kill the child. The
 * run is already appending to the user's transcript; killing it mid-turn is the damage this module
 * exists to avoid. `onExit` therefore runs off the child's own exit, not off the stream's.
 */
function streamChild(child: ChildProcessWithoutNullStreams, onExit: () => void): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let stderr = '';
  let exited = false;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          closed = true;
        }
      };
      const safeClose = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed by a cancel */
        }
      };

      child.stdout.on('data', (chunk: Buffer) => safeEnqueue(new Uint8Array(chunk)));
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < STDERR_CAP) stderr += chunk.toString('utf8').slice(0, STDERR_CAP - stderr.length);
      });

      const finish = (code: number | null, signal: NodeJS.Signals | null, error?: string) => {
        if (exited) return;
        exited = true;
        const status = {
          type: 'cockpit_status',
          event: 'exit',
          code,
          signal,
          ...(error ? { error } : {}),
          ...(stderr.trim() ? { stderr: stderr.trim() } : {}),
        };
        safeEnqueue(encoder.encode(`${JSON.stringify(status)}\n`));
        safeClose();
        onExit();
      };

      child.on('error', (err) => finish(null, null, err.message));
      child.on('close', (code, signal) => finish(code, signal));
    },
    cancel() {
      // Intentionally empty: see the note above. The lock is released on child exit.
    },
  });
}

function spawnClaude(args: string[], cwd: string, prompt: string): ChildProcessWithoutNullStreams {
  const child = spawn('claude', args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });
  // The prompt travels here, never in argv. An EPIPE (the child died before reading) must not
  // take the server down with it.
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);
  return child;
}

// ---------------------------------------------------------------------------
// continueSession
// ---------------------------------------------------------------------------

/**
 * Append a message to an existing session and stream the reply.
 *
 * Refuses — never partially proceeds — on: a live process (`alive`), an unprovable liveness
 * answer (`unresolvable`), a missing transcript, a concurrent cockpit run (`busy`), a
 * transcript that moved between the guard and the spawn (`transcript-changed`), and a session
 * whose recorded directory and repo root are both gone (`missing-cwd`).
 */
export async function continueSession(input: ContinueInput): Promise<ContinueResult> {
  const sessionId = input?.sessionId;
  if (!isSessionId(sessionId)) {
    return {
      ok: false,
      sessionId: String(sessionId ?? ''),
      reason: 'bad-request',
      detail: 'sessionId must be a uuid',
    };
  }
  const message = typeof input.message === 'string' ? input.message : '';
  if (message.trim() === '') {
    return { ok: false, sessionId, reason: 'bad-request', detail: 'message is empty' };
  }
  const model = modelArgs(input.model);
  if (model === null) {
    return { ok: false, sessionId, reason: 'bad-request', detail: 'model is not a valid model name' };
  }

  // Layer 3 first: it is the only layer that can see a sibling request which has passed its own
  // checks but has not caused a byte to be written yet.
  const lock: SessionLock | null = acquireSessionLock(sessionId);
  if (!lock) {
    return {
      ok: false,
      sessionId,
      reason: 'busy',
      detail: 'another cockpit run is already writing to this session',
      jumpUrl: jumpUrlFor(sessionId),
    };
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    lock.release();
  };

  try {
    const guard = await assertSafeToWrite(sessionId);
    if (!guard.ok) {
      release();
      return {
        ok: false,
        sessionId,
        reason: guard.reason,
        detail: guard.detail,
        pid: guard.pid,
        jumpUrl: guard.jumpUrl,
      };
    }

    const { transcriptPath, bytes } = guard;

    // Where to run. The registry knows the cwd for sessions that are registered; for everything
    // else the transcript's own Family A records carry it. ~67 % of recorded cwds are
    // cleaned-up worktrees (SCHEMA-NOTES §11), so existence is checked, not assumed, and the
    // repo root is the fallback because it survives worktree cleanup.
    let recordedCwd = guard.cwd;
    let repoRoot: string | undefined;
    if (!isDirectory(recordedCwd)) {
      try {
        const facts = parseTranscriptTail(transcriptPath);
        recordedCwd = recordedCwd || facts.cwd;
        repoRoot = facts.repoRoot;
      } catch {
        /* transcript unreadable; the checks below refuse */
      }
    }
    repoRoot = repoRoot ?? resolveRepoRoot(recordedCwd);

    const runCwd = isDirectory(recordedCwd) ? recordedCwd : isDirectory(repoRoot) ? repoRoot : null;
    if (!runCwd) {
      release();
      return {
        ok: false,
        sessionId,
        reason: 'missing-cwd',
        detail:
          `neither the session cwd (${recordedCwd ?? 'unknown'}) nor its repo root ` +
          `(${repoRoot ?? 'unknown'}) exists on disk`,
      };
    }

    const args = ['-r', sessionId, '-p', '--output-format', 'stream-json', '--verbose', ...model];

    // Layer 2, in the statement immediately before the spawn. Do not insert anything here.
    if (!recheckBytes(transcriptPath, bytes)) {
      release();
      return {
        ok: false,
        sessionId,
        reason: 'transcript-changed',
        detail: `transcript changed length since the guard ran (expected ${bytes} bytes)`,
        jumpUrl: jumpUrlFor(sessionId),
      };
    }
    const child = spawnClaude(args, runCwd, message);

    if (typeof child.pid !== 'number') {
      release();
      return { ok: false, sessionId, reason: 'spawn-failed', detail: 'claude did not start' };
    }

    return {
      ok: true,
      sessionId,
      transcriptPath,
      bytes,
      pid: child.pid,
      cwd: runCwd,
      stream: streamChild(child, release),
    };
  } catch (err) {
    release();
    return {
      ok: false,
      sessionId,
      reason: 'spawn-failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// dispatchNew
// ---------------------------------------------------------------------------

/**
 * Start a fresh session in `cwd` and hand back its id immediately.
 *
 * The id is generated here rather than read out of the output stream so the board can render a
 * card the instant the button is pressed, before the run has produced anything. Verified:
 * `--session-id <uuid>` is honoured and `claude -r <uuid>` later resumes it with full context.
 *
 * No guard: a freshly generated uuid has no conversation to fork.
 */
export function dispatchNew(input: DispatchInput): DispatchResult {
  const prompt = typeof input?.prompt === 'string' ? input.prompt : '';
  if (prompt.trim() === '') {
    return { ok: false, reason: 'bad-request', detail: 'prompt is empty' };
  }
  const model = modelArgs(input.model);
  if (model === null) {
    return { ok: false, reason: 'bad-request', detail: 'model is not a valid model name' };
  }
  if (!isDirectory(input.cwd)) {
    return { ok: false, reason: 'missing-cwd', detail: `cwd does not exist: ${input?.cwd ?? ''}` };
  }

  const sessionId = randomUUID();
  const args = [
    '-p',
    '--session-id',
    sessionId,
    '--output-format',
    'stream-json',
    '--verbose',
    ...model,
  ];

  try {
    const child = spawnClaude(args, input.cwd, prompt);
    if (typeof child.pid !== 'number') {
      return { ok: false, reason: 'spawn-failed', detail: 'claude did not start', sessionId };
    }
    return {
      ok: true,
      sessionId,
      pid: child.pid,
      cwd: input.cwd,
      stream: streamChild(child, () => {}),
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'spawn-failed',
      detail: err instanceof Error ? err.message : String(err),
      sessionId,
    };
  }
}
