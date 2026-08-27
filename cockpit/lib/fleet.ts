/**
 * The join layer: unions live process state (`lib/agents.ts`) with transcript facts
 * (`lib/scan.ts` / `lib/transcript.ts`) into the board's view model, keyed on `sessionId`.
 *
 * The two sources do not overlap. `claude agents --json --all` reports only processes the CLI
 * still tracks (interactive PIDs plus recently-dispatched background agents — a handful at a
 * time). `scanRecent()` reports every session transcript touched inside the window (dozens over
 * 7 days). A session that finished an hour ago and dropped off the live list is exactly what
 * the user wants to see, so `getFleet()` returns the UNION of both id sets, not the intersection:
 * cards come from liveness alone, transcript alone, or both.
 *
 * `status` is the single most important field on a card (see FleetStatus below) and is computed
 * independently here rather than reusing `SessionSummary.activity` from scan.ts: `activity` has
 * no notion of live-process state at all (it is a transcript+subagent-only heuristic), while the
 * board's `working` / `waiting` states are explicitly gated on a live process per SCHEMA-NOTES §8.
 *
 * Nothing here throws. `readLiveSessions()` is documented never to throw, `scanRecent()` reports
 * failures per-file rather than throwing, and every path derived from a `cwd` (existence check,
 * repo/worktree split) is defensive for the same reason cwd can be: missing, deleted out from
 * under a stale worktree record, or just weird.
 */

import { existsSync } from "node:fs";
import { posix } from "node:path";
import { isAlive, readLiveSessions, type LiveSession } from "./agents.ts";
import { scanRecent, DEFAULT_WINDOW_MS, type SessionSummary, type ScanDrift } from "./scan.ts";

/**
 * Answers "is this stuck" — the board's single most load-bearing field.
 *
 *   - `working`    a live process, and the transcript shows the turn is in flight (newest
 *                  assistant record asked for a tool, a human prompt landed after the newest
 *                  assistant reply, or a background subagent is still writing).
 *   - `waiting`    a live process whose newest assistant record ended its turn. This is
 *                  "waiting on you" and sorts to the very top of the board.
 *   - `stalled`    the transcript still reads mid-turn, but nothing has been written to it in
 *                  over 30 minutes — abandoned, not running. Two real sessions in this corpus
 *                  are idle 336h and 540h (SCHEMA-NOTES §8).
 *   - `done`       no live process, and the session is not a stale mid-turn zombie.
 *   - `unknown`    no transcript facts to reason from. Never guessed.
 */
export type FleetStatus = "working" | "waiting" | "stalled" | "done" | "unknown";

/** Display and sort order: waiting first, then working, stalled, unknown, done. */
export const FLEET_STATUS_ORDER: readonly FleetStatus[] = [
  "waiting",
  "working",
  "stalled",
  "unknown",
  "done",
];

/** A mid-turn transcript untouched this long reads as abandoned, not in-flight. SCHEMA-NOTES §8. */
const STALLED_AFTER_MS = 30 * 60 * 1000;

export type FleetCard = {
  sessionId: string;
  /** Always non-empty: live agent name, else transcript title, else a short session id. */
  name: string;
  /** Transcript-derived title only (`custom-title` / `ai-title`). Absent for ~1/3 of sessions. */
  title?: string;
  cwd: string;
  /** Repo basename — prefers the transcript's worktree-aware `repoRoot` when available. */
  repoLabel: string;
  /** Worktree directory name, present when cwd is a `.claude/worktrees/<name>` checkout. */
  worktreeName?: string;
  /** Whether `cwd` exists on disk right now. Worktrees frequently get deleted after merge. */
  cwdExists: boolean;
  /** "interactive" | "background" from the live source, else "transcript" when only history exists. */
  kind: string;
  startedAt: number;
  pid?: number;
  state?: string;
  alive: boolean;

  status: FleetStatus;
  /** Human-readable evidence for `status`, for a tooltip — mirrors turnStateSignal/activitySignal. */
  statusSignal: string;

  /** Verbatim most recent request, from `last-prompt` (§4/§5). Present for ~all sessions with a transcript. */
  lastPrompt?: string;
  /** Newest assistant text in the tail window. */
  lastDeliverable?: string;
  branch?: string;
  prNumber?: number;
  prUrl?: string;
  /** Comma-joined model set actually used (already excludes the synthetic placeholder). */
  model?: string;
  /** epoch ms of last known activity: max(file mtime, newest in-content timestamp), else startedAt. */
  lastActivityAt: number;
};

export type FleetResult = {
  cards: FleetCard[];
  error?: string;
  ms: number;
  windowMs: number;
  drift: ScanDrift;
};

export interface FleetOptions {
  /** Read window for transcript activity. Default 7 days, matching scan.ts. */
  windowMs?: number;
}

const WORKTREE_MARKER = "/.claude/worktrees/";

/** Never throws: an unreadable or missing path just resolves to `false`. */
function checkExists(p: string): boolean {
  if (!p) return false;
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

/**
 * Walk a cwd up past any `/.claude/worktrees/<name>` segment to find the real repo root, and
 * pull the worktree's own directory name out as a subtitle. Paths with no worktree segment pass
 * through unchanged.
 *
 * Example: "/Users/x/repo/.claude/worktrees/foo/nested" ->
 *   { repoRoot: "/Users/x/repo", worktreeName: "foo" }
 */
function splitWorktree(cwd: string): { repoRoot: string; worktreeName?: string } {
  if (!cwd) return { repoRoot: "" };
  const idx = cwd.indexOf(WORKTREE_MARKER);
  if (idx === -1) return { repoRoot: cwd };
  const repoRoot = cwd.slice(0, idx) || "/";
  const rest = cwd.slice(idx + WORKTREE_MARKER.length);
  const worktreeName = rest.split("/")[0] || undefined;
  return { repoRoot, worktreeName };
}

/**
 * Derive a human label + worktree subtitle from a session cwd. Prefers the transcript's own
 * `repoRoot` when one was supplied (scan.ts already walks past worktree segments and cross-checks
 * existence — SCHEMA-NOTES §11); falls back to a local split for live-only cards. Never throws;
 * worst case is an "(unknown)" label.
 */
function deriveRepoLabel(
  cwd: string,
  transcriptRepoRoot?: string,
): { repoLabel: string; worktreeName?: string } {
  const local = splitWorktree(cwd);
  const repoRoot = transcriptRepoRoot || local.repoRoot;
  const base = repoRoot ? posix.basename(repoRoot) : "";
  return { repoLabel: base || repoRoot || "(unknown)", worktreeName: local.worktreeName };
}

/**
 * Best known activity time. Transcript facts (file mtime vs. newest in-content timestamp,
 * whichever is newer — sidecar records like `last-prompt` bump mtime without a timestamp of
 * their own) beat a live-only card's process start time.
 */
function computeLastActivityAt(live: LiveSession | undefined, summary: SessionSummary | undefined): number {
  if (summary) {
    const contentTs = summary.lastTimestamp ? Date.parse(summary.lastTimestamp) : NaN;
    // statSync().mtimeMs carries sub-millisecond precision on APFS; round so every epoch-ms field
    // on the card is a plain integer, matching Date.now() and Date.parse().
    return Math.round(Math.max(summary.mtimeMs, Number.isFinite(contentTs) ? contentTs : 0));
  }
  return live?.startedAt ?? 0;
}

interface StatusResult {
  status: FleetStatus;
  statusSignal: string;
}

/**
 * The board's status field. Computed from the union of live-process state and transcript facts;
 * see the FleetStatus doc comment for the five buckets. `stalled` is checked before liveness on
 * purpose: a process that still shows as alive but has not written to its own transcript in over
 * 30 minutes while supposedly mid-tool-call is exactly the "is it stuck" case the board exists to
 * catch, not a false "working" green light.
 */
function computeStatus(alive: boolean, summary: SessionSummary | undefined): StatusResult {
  if (!summary || summary.recordCount === 0) {
    return {
      status: "unknown",
      statusSignal: summary
        ? "session file has no parseable records in the read window"
        : "no session transcript found for this live process",
    };
  }

  const { turnState, backgroundAgentActive, idleMs, turnStateSignal } = summary;

  if (turnState === "mid-turn" && idleMs > STALLED_AFTER_MS) {
    return {
      status: "stalled",
      statusSignal: `${turnStateSignal} — no transcript write in ${Math.round(idleMs / 60000)}m`,
    };
  }

  if (!alive) {
    return { status: "done", statusSignal: "no live process" };
  }

  if (turnState === "mid-turn") {
    return { status: "working", statusSignal: turnStateSignal };
  }

  // The main transcript cannot see subagent work at all (SCHEMA-NOTES §8's blind spot): a session
  // whose own transcript looks idle while a background subagent is still writing is working, not
  // waiting on the user. This overrides an otherwise-"waiting" verdict.
  if (backgroundAgentActive) {
    return {
      status: "working",
      statusSignal: "a background subagent transcript is newer than this session's own",
    };
  }

  if (turnState === "awaiting-user") {
    return { status: "waiting", statusSignal: turnStateSignal };
  }

  // Alive, with transcript facts, but no assistant record yet to judge from (freshly started).
  // Nothing suggests it is idle-waiting, so this reads as working rather than a guess at "unknown"
  // when facts do in fact exist for this session.
  return { status: "working", statusSignal: turnStateSignal };
}

function toCard(
  sessionId: string,
  live: LiveSession | undefined,
  summary: SessionSummary | undefined,
): FleetCard {
  const alive = live ? isAlive(live) : false;
  const cwd = summary?.cwd ?? live?.cwd ?? "";
  const { repoLabel, worktreeName } = deriveRepoLabel(cwd, summary?.repoRoot);
  const cwdExists = summary ? summary.cwdExists : checkExists(cwd);
  const { status, statusSignal } = computeStatus(alive, summary);
  // transcript.ts already excludes the synthetic placeholder before it ever reaches `models`;
  // filtered again here defensively since this file is the one the task holds to that promise.
  const models = (summary?.models ?? []).filter((m) => m !== "<synthetic>");
  const startedAt =
    live?.startedAt ??
    (summary?.firstTimestamp ? Date.parse(summary.firstTimestamp) : undefined) ??
    (summary?.mtimeMs !== undefined ? Math.round(summary.mtimeMs) : undefined) ??
    0;

  return {
    sessionId,
    name: live?.name || summary?.title || `session ${sessionId.slice(0, 8)}`,
    title: summary?.title,
    cwd,
    repoLabel,
    worktreeName,
    cwdExists,
    kind: live?.kind ?? "transcript",
    startedAt,
    pid: live?.pid,
    state: live?.state,
    alive,
    status,
    statusSignal,
    lastPrompt: summary?.lastUserMessage,
    lastDeliverable: summary?.lastAssistantText,
    branch: summary?.gitBranch,
    prNumber: summary?.prNumber,
    prUrl: summary?.prUrl,
    model: models.length > 0 ? models.join(", ") : undefined,
    lastActivityAt: computeLastActivityAt(live, summary),
  };
}

const STATUS_RANK: Record<FleetStatus, number> = Object.fromEntries(
  FLEET_STATUS_ORDER.map((s, i) => [s, i]),
) as Record<FleetStatus, number>;

/** Sort order the board wants: waiting, working, stalled, unknown, done; newest activity within each. */
function compareCards(a: FleetCard, b: FleetCard): number {
  const rankDiff = STATUS_RANK[a.status] - STATUS_RANK[b.status];
  if (rankDiff !== 0) return rankDiff;
  return b.lastActivityAt - a.lastActivityAt;
}

/**
 * Build the fleet: union live process state with transcript facts, keyed on sessionId, and
 * compute one status per card. Synchronous scan + concurrent liveness check — `readLiveSessions()`
 * spawns a subprocess (up to a 5s timeout) while `scanRecent()` runs in-process and typically
 * finishes in single-digit milliseconds, so they run in parallel rather than back to back.
 */
export async function getFleet(opts: FleetOptions = {}): Promise<FleetResult> {
  const t0 = Date.now();
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;

  const livePromise = readLiveSessions();
  const scan = scanRecent({ windowMs, stalledAfterMs: STALLED_AFTER_MS });
  const { sessions: liveSessions, error: liveError } = await livePromise;

  const liveBySession = new Map<string, LiveSession>();
  for (const s of liveSessions) liveBySession.set(s.sessionId, s);
  const summaryBySession = new Map<string, SessionSummary>();
  for (const s of scan.sessions) summaryBySession.set(s.sessionId, s);

  // The union of both id sets — a session recently finished and no longer live is exactly what
  // the board should show, and a session too new for a transcript write yet should still appear.
  const ids = new Set<string>([...liveBySession.keys(), ...summaryBySession.keys()]);
  const cards = [...ids]
    .map((id) => toCard(id, liveBySession.get(id), summaryBySession.get(id)))
    .sort(compareCards);

  return {
    cards,
    error: liveError,
    ms: Date.now() - t0,
    windowMs,
    drift: scan.drift,
  };
}
