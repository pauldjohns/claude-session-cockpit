/**
 * The two-writer guard.
 *
 * ## What it is defending against
 *
 * Measured on this machine 2026-08-21, not theorised: two concurrent
 * `claude -r <id> -p` calls against one session **both succeed**. No lock, no error, no
 * warning, both exit 0, both answer. The transcript gains a `parentUuid` with two `user`
 * children and one branch silently vanishes from the conversation on the next resume. The
 * file still parses; the board still renders it. Reproduced live against a throwaway session
 * under /private/tmp: parent `0b049492…` ended up with children "…alpha" and "…bravo".
 *
 * Baseline for that signature across the user's real corpus (155 session transcripts,
 * `~/.claude/projects`): **0 files** have a `parentUuid` with more than one non-meta,
 * non-tool-result `user` child. (647 parents do have >1 child of *any* kind — 511 of them the
 * ordinary `assistant:tool_use` + `user:tool_result` pair — so "any multi-child parent" is not
 * the signature; "two prompts under one parent" is.)
 *
 * ## Why the previous design was rejected
 *
 * It keyed on a hook-written "idle" status. `idle` means Claude finished and the user is *reading*,
 * which is precisely the moment before he types. The check was anti-correlated with safety.
 *
 * ## The three layers here, in order
 *
 * 1. **PID liveness.** Resolve the session's process from `~/.claude/sessions/*.json` and
 *    `claude agents --json --all`, then `kill -0` it. A live PID is a hard refusal carrying a
 *    `claude://resume?session=<id>` jump link. PID reuse is real, so the process start time is
 *    cross-checked too.
 * 2. **Byte recheck (TOCTOU closer).** Record the transcript length at guard time, re-stat it
 *    in the instruction immediately before spawn, abort on any change.
 * 3. **Advisory lock.** An `O_EXCL` lockfile per session, so two cockpit requests (same server
 *    or two servers) cannot both pass layers 1 and 2 inside the same few hundred ms — neither
 *    of those layers can see a sibling that has not written anything yet.
 *
 * Layer 1 alone is not enough and the limit is measured: `claude -p` (print mode) **does not
 * write a `~/.claude/sessions/*.json` entry** and does not appear in `claude agents --json`.
 * So the PID layer sees interactive sessions — the dangerous case, the user sitting in one — and is
 * blind to other headless runs. Layers 2 and 3 exist because of that blindness, not as garnish.
 *
 * ## The timezone trap, which would have silently disabled the whole guard
 *
 * `~/.claude/sessions/<pid>.json` writes `procStart` as **UTC** with no zone marker
 * (`"Sat Aug 22 03:39:22 2026"`), while `ps -o lstart=` prints **local** time for the same
 * instant (`"Fri Aug 21 21:39:22 2026"` in a UTC-6 zone). Verified 4/4 against live PIDs: parsing
 * `procStart` as UTC and `ps` output as local yields the identical instant to the second.
 * A naive string comparison never matches, `isProcessAlive` returns false for every live
 * session, and the guard waves every write through. Compare instants, never strings.
 *
 * Nothing here throws for an environmental reason. Every unknown resolves toward *refusing*,
 * because refusing costs the user one click on a jump link and permitting costs him a lost branch.
 */

import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { readLiveSessions } from './agents.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_SESSIONS_DIR = join(homedir(), '.claude', 'sessions');
export const DEFAULT_PROJECTS_ROOT = join(homedir(), '.claude', 'projects');
export const LOCK_DIR = join(tmpdir(), 'mission-control-locks');

/** Session ids are uuids. Anything else is rejected before it reaches a path or an argv. */
export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `ps` and `procStart` both have one-second resolution and `startedAt` is milliseconds, so the
 * two can legitimately differ by a fraction of a second. Two seconds of slack costs nothing:
 * the only way it hurts is a recycled PID that started within 2 s of the original, and that
 * error lands on "treat as the same session", i.e. refuse.
 */
const PROC_START_TOLERANCE_MS = 2_000;

const PS_TIMEOUT_MS = 3_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolvedSessionPid {
  pid: number;
  /** As recorded by the CLI: UTC, `Sat Aug 22 03:39:22 2026`. Absent on agents-only hits. */
  procStart?: string;
  /** Epoch ms the CLI recorded for the session start; fallback when `procStart` is absent. */
  startedAt?: number;
  cwd: string;
  source: 'registry' | 'agents' | 'registry+agents';
}

export interface ResolveOptions {
  /** Override for tests. Defaults to `~/.claude/sessions`. */
  sessionsDir?: string;
  /** Override for tests. Defaults to `~/.claude/projects`. */
  projectsRoot?: string;
}

export interface LivenessResolution {
  /** Every process that claims this session, from both sources, de-duplicated by pid. */
  candidates: ResolvedSessionPid[];
  /** The `~/.claude/sessions` directory was readable. */
  registryAvailable: boolean;
  /** `claude agents --json --all` answered. */
  agentsAvailable: boolean;
  agentsError?: string;
}

export type WriteRefusalReason = 'alive' | 'unresolvable' | 'missing-transcript';

export type SafeToWrite =
  | {
      ok: true;
      sessionId: string;
      transcriptPath: string;
      /** Byte length at the moment of the check. Feed this to `recheckBytes` before spawning. */
      bytes: number;
      /** cwd recorded by the process registry, when the session is registered. */
      cwd?: string;
    }
  | {
      ok: false;
      sessionId: string;
      reason: WriteRefusalReason;
      /** Present when the refusal is `alive`. */
      pid?: number;
      /** Present when the refusal is `alive`: where to go instead of writing. */
      jumpUrl?: string;
      /** Human-readable evidence for the refusal. Safe to show in the UI. */
      detail: string;
    };

// ---------------------------------------------------------------------------
// Session id / transcript resolution
// ---------------------------------------------------------------------------

export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_RE.test(value);
}

/** `claude://resume?session=<id>` — where the refusal sends the user instead of writing. */
export function jumpUrlFor(sessionId: string): string {
  return `claude://resume?session=${sessionId}`;
}

/**
 * Find `<projectsRoot>/<projectDir>/<sessionId>.jsonl`.
 *
 * Depth 2 with a uuid basename is the session rule (SCHEMA-NOTES §1); anything deeper is a
 * subagent transcript carrying the *parent's* sessionId. The project directory is an encoded
 * cwd (`/`→`-` and `.`→`-`, lossy), so it is searched rather than computed.
 */
export function findTranscriptPath(
  sessionId: string,
  projectsRoot: string = DEFAULT_PROJECTS_ROOT,
): string | null {
  if (!isSessionId(sessionId)) return null;
  const wanted = `${sessionId}.jsonl`;
  let projects: string[];
  try {
    projects = readdirSync(projectsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return null;
  }
  for (const dir of projects) {
    const candidate = join(projectsRoot, dir, wanted);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* not in this project dir */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// PID resolution
// ---------------------------------------------------------------------------

function readRegistryCandidates(
  sessionId: string,
  sessionsDir: string,
): { entries: ResolvedSessionPid[]; available: boolean } {
  let names: string[];
  try {
    names = readdirSync(sessionsDir).filter((n) => n.endsWith('.json'));
  } catch {
    return { entries: [], available: false };
  }
  const entries: ResolvedSessionPid[] = [];
  for (const name of names) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(sessionsDir, name), 'utf8'));
    } catch {
      // A half-written or deleted registry file is not evidence of anything. Skip it; the
      // directory itself was readable, so the source still counts as available.
      continue;
    }
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (r.sessionId !== sessionId) continue;
    if (typeof r.pid !== 'number' || !Number.isInteger(r.pid) || r.pid <= 0) continue;
    entries.push({
      pid: r.pid,
      procStart: typeof r.procStart === 'string' ? r.procStart : undefined,
      startedAt: typeof r.startedAt === 'number' ? r.startedAt : undefined,
      cwd: typeof r.cwd === 'string' ? r.cwd : '',
      source: 'registry',
    });
  }
  return { entries, available: true };
}

/**
 * Every process claiming this session, plus whether each source could be consulted at all.
 *
 * "Could not be consulted" is a materially different answer from "said no", and only the
 * refusal path can tell them apart — see `assertSafeToWrite`.
 */
export async function resolveLiveness(
  sessionId: string,
  opts: ResolveOptions = {},
): Promise<LivenessResolution> {
  if (!isSessionId(sessionId)) {
    return { candidates: [], registryAvailable: false, agentsAvailable: false };
  }
  const sessionsDir = opts.sessionsDir ?? DEFAULT_SESSIONS_DIR;

  const registry = readRegistryCandidates(sessionId, sessionsDir);
  const live = await readLiveSessions(true);

  // `readLiveSessions` reports shape drift through the same `error` field it uses for a failed
  // command, so a non-empty session list still counts as an answer.
  const agentsAvailable = live.error === undefined || live.sessions.length > 0;

  const byPid = new Map<number, ResolvedSessionPid>();
  for (const e of registry.entries) byPid.set(e.pid, e);

  for (const s of live.sessions) {
    if (s.sessionId !== sessionId) continue;
    if (typeof s.pid !== 'number' || !Number.isInteger(s.pid) || s.pid <= 0) continue;
    const existing = byPid.get(s.pid);
    if (existing) {
      existing.source = 'registry+agents';
      if (existing.cwd === '' && s.cwd) existing.cwd = s.cwd;
      if (existing.startedAt === undefined && s.startedAt) existing.startedAt = s.startedAt;
    } else {
      byPid.set(s.pid, {
        pid: s.pid,
        startedAt: s.startedAt || undefined,
        cwd: s.cwd ?? '',
        source: 'agents',
      });
    }
  }

  const rank = { 'registry+agents': 0, agents: 1, registry: 2 } as const;
  const candidates = [...byPid.values()].sort((a, b) => rank[a.source] - rank[b.source]);

  return {
    candidates,
    registryAvailable: registry.available,
    agentsAvailable,
    agentsError: live.error,
  };
}

/**
 * The session's process, or null when neither source names one.
 *
 * `null` is *not* proof the session is idle — it also happens when a source is unreachable, and
 * print-mode runs never register at all. Callers deciding whether to write must use
 * `assertSafeToWrite`, which keeps those cases apart.
 */
export async function resolveSessionPid(
  sessionId: string,
  opts: ResolveOptions = {},
): Promise<ResolvedSessionPid | null> {
  const { candidates } = await resolveLiveness(sessionId, opts);
  return candidates[0] ?? null;
}

// ---------------------------------------------------------------------------
// Liveness
// ---------------------------------------------------------------------------

/** Process start instant from `ps`, in epoch ms. `ps` prints **local** time. */
export function readProcessStartMs(pid: number): number | null {
  let out: string;
  try {
    out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: PS_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    // Nonzero exit (no such process) or `ps` unavailable. Indistinguishable here, and the
    // caller treats null as "cannot verify", which biases toward refusing.
    return null;
  }
  const text = out.trim();
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Candidate instants for a recorded start time.
 *
 * UTC first because that is what the registry measurably writes. The local reading is kept as
 * a second candidate purely so a future Claude Code that switches to local time degrades into
 * "matches, refuse the write" rather than "never matches, permit every write".
 */
function procStartCandidatesMs(procStart: string | number): number[] {
  if (typeof procStart === 'number') return Number.isFinite(procStart) ? [procStart] : [];
  const text = procStart.trim();
  if (!text) return [];
  const out: number[] = [];
  const asUtc = Date.parse(`${text} UTC`);
  if (!Number.isNaN(asUtc)) out.push(asUtc);
  const asLocal = Date.parse(text);
  if (!Number.isNaN(asLocal) && !out.includes(asLocal)) out.push(asLocal);
  return out;
}

/**
 * Is this PID still the process that owns the session?
 *
 * `kill -0` answers "a process with this id exists". PID reuse means that is not the same
 * question as "it is still *that* process", so the start time is compared as well: a PID that
 * exists but started at a different instant is a different program and is not this session.
 *
 * Every ambiguous branch returns `true`. `true` means "refuse to write", which is recoverable
 * (the user clicks the jump link); `false` on a live session is not.
 */
export function isProcessAlive(pid: number, procStart?: string | number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM: the process exists but belongs to another user. It exists — that is what matters.
    if (code === 'EPERM') return true;
    return false;
  }

  if (procStart === undefined || procStart === null || procStart === '') return true;

  const expected = procStartCandidatesMs(procStart);
  if (expected.length === 0) return true;

  const actual = readProcessStartMs(pid);
  if (actual === null) return true;

  return expected.some((ms) => Math.abs(ms - actual) <= PROC_START_TOLERANCE_MS);
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * May the cockpit append to this session's conversation right now?
 *
 * Refusals, in the order they are decided:
 *
 * - `alive` — a process owning this session is running. Hard stop; `jumpUrl` is where to go.
 * - `unresolvable` — not a session id, or a liveness source could not be consulted, so
 *   "no live process" is unproven. The design's fallback for this case is `--fork-session`,
 *   never a write.
 * - `missing-transcript` — no `<projects>/<dir>/<id>.jsonl`. Without it there is no byte count,
 *   so layer 2 cannot arm, so there is nothing to write against safely.
 */
export async function assertSafeToWrite(
  sessionId: string,
  opts: ResolveOptions = {},
): Promise<SafeToWrite> {
  if (!isSessionId(sessionId)) {
    return {
      ok: false,
      sessionId: String(sessionId),
      reason: 'unresolvable',
      detail: 'not a session id (expected a uuid)',
    };
  }

  const liveness = await resolveLiveness(sessionId, opts);

  for (const c of liveness.candidates) {
    if (isProcessAlive(c.pid, c.procStart ?? c.startedAt)) {
      return {
        ok: false,
        sessionId,
        reason: 'alive',
        pid: c.pid,
        jumpUrl: jumpUrlFor(sessionId),
        detail:
          `pid ${c.pid} is running this session (source: ${c.source}` +
          `${c.cwd ? `, cwd ${c.cwd}` : ''}). Writing now would fork the conversation.`,
      };
    }
  }

  // Both sources must have answered before "nobody is running it" is a conclusion rather than
  // a shrug. A dead registry entry (the process exited without cleaning up) is a real answer:
  // it was checked above and found dead.
  if (!liveness.registryAvailable || !liveness.agentsAvailable) {
    const missing = [
      liveness.registryAvailable ? null : 'session registry unreadable',
      liveness.agentsAvailable
        ? null
        : `claude agents unavailable${liveness.agentsError ? `: ${liveness.agentsError}` : ''}`,
    ]
      .filter((s): s is string => s !== null)
      .join('; ');
    return {
      ok: false,
      sessionId,
      reason: 'unresolvable',
      detail: `cannot prove no process owns this session (${missing})`,
    };
  }

  const transcriptPath = findTranscriptPath(sessionId, opts.projectsRoot);
  if (!transcriptPath) {
    return {
      ok: false,
      sessionId,
      reason: 'missing-transcript',
      detail: 'no transcript found under the projects root for this session id',
    };
  }

  let bytes: number;
  try {
    bytes = statSync(transcriptPath).size;
  } catch {
    return {
      ok: false,
      sessionId,
      reason: 'missing-transcript',
      detail: 'transcript disappeared between discovery and stat',
    };
  }

  return {
    ok: true,
    sessionId,
    transcriptPath,
    bytes,
    cwd: liveness.candidates[0]?.cwd || undefined,
  };
}

/**
 * The TOCTOU closer. Call this in the statement immediately before spawning, never earlier.
 *
 * Transcripts are append-only (SCHEMA-NOTES §9: 0 files shrank, 0 head fingerprints changed
 * across a full working session), so any change in length means somebody else wrote between
 * the guard and the spawn. Gone or shrunk is also a change, and also a refusal.
 */
export function recheckBytes(transcriptPath: string, expectedBytes: number): boolean {
  try {
    return statSync(transcriptPath).size === expectedBytes;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Advisory lock
// ---------------------------------------------------------------------------

export interface SessionLock {
  sessionId: string;
  path: string;
  release(): void;
}

interface LockRecord {
  pid: number;
  at: number;
  sessionId: string;
}

function readLockRecord(path: string): LockRecord | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.pid !== 'number') return null;
    return {
      pid: r.pid,
      at: typeof r.at === 'number' ? r.at : 0,
      sessionId: typeof r.sessionId === 'string' ? r.sessionId : '',
    };
  } catch {
    return null;
  }
}

/**
 * Serialise cockpit writes to one session across processes.
 *
 * Layers 1 and 2 cannot see a sibling request that has passed its own checks but has not made
 * the child process write anything yet — a window of a few hundred ms that two clicks, or two
 * fetches, land inside easily. `O_EXCL` creation is the primitive that closes it.
 *
 * A lock whose owning process is dead is stolen, so a crashed cockpit does not wedge a session
 * permanently.
 */
export function acquireSessionLock(sessionId: string, lockDir: string = LOCK_DIR): SessionLock | null {
  if (!isSessionId(sessionId)) return null;
  const path = join(lockDir, `${sessionId}.lock`);

  const tryCreate = (): boolean => {
    try {
      mkdirSync(lockDir, { recursive: true });
      const fd = openSync(path, 'wx');
      try {
        const rec: LockRecord = { pid: process.pid, at: Date.now(), sessionId };
        writeSync(fd, JSON.stringify(rec));
      } finally {
        closeSync(fd);
      }
      return true;
    } catch {
      return false;
    }
  };

  if (tryCreate()) return makeLock(sessionId, path);

  const holder = readLockRecord(path);
  const holderAlive = holder ? isProcessAlive(holder.pid) : true;
  if (holderAlive) return null;

  try {
    unlinkSync(path);
  } catch {
    return null;
  }
  return tryCreate() ? makeLock(sessionId, path) : null;
}

function makeLock(sessionId: string, path: string): SessionLock {
  let released = false;
  return {
    sessionId,
    path,
    release() {
      if (released) return;
      released = true;
      try {
        if (existsSync(path)) unlinkSync(path);
      } catch {
        /* best effort; a stale lock is stolen on the next attempt */
      }
    },
  };
}
