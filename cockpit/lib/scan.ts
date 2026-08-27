/**
 * scan.ts — one-shot fleet scan of `~/.claude/projects`.
 *
 * No database, no daemon, no persistence, no globals. `scanRecent()` walks the project tree,
 * keeps the session files whose mtime falls inside the window, tail-reads each one through
 * `lib/transcript.ts`, and returns them sorted by last activity.
 *
 * Why there is no index: measured on the real tree, walk + stat of every file is ~90 ms, and
 * tail-reading the last 64 KB of every file modified in the last 7 days is single-digit
 * milliseconds. An index would cache a computation cheaper than the cache lookup.
 *
 * The depth-2 rule is load-bearing. `~/.claude/projects/**\/*.jsonl` matches ~1,990 files of which
 * only ~155-190 are sessions; the rest are subagent and workflow transcripts nested one level
 * deeper, plus foreign schemas with no sessionId at all. See SCHEMA-NOTES.md §1.
 */

import { readdirSync, statSync, existsSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  parseTranscriptTail,
  isSessionFileName,
  decodeProjectDir,
  DEFAULT_TAIL_BYTES,
  DEFAULT_MAX_TEXT_CHARS,
} from './transcript.ts';
import type { TranscriptFacts, DriftSighting, TurnState } from './transcript.ts';

export const DEFAULT_ROOT = join(homedir(), '.claude', 'projects');
export const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionFileRef {
  filePath: string;
  /** Encoded project directory name, e.g. `-Users-me-Documents-thing`. */
  projectDir: string;
  sessionId: string;
  size: number;
  mtimeMs: number;
}

/**
 * `mid-turn` split by whether the file is still moving. A session whose newest assistant record
 * says `tool_use` but whose file has not changed in a long time was killed mid-turn, and that is a
 * different cell on the board from one that is actively running.
 */
export type Activity = 'running' | 'awaiting-user' | 'stalled' | 'unknown';

export interface SessionSummary {
  sessionId: string;
  filePath: string;
  projectDir: string;
  /** Best-effort decode of `projectDir` back to a path. Lossy — dashes and slashes are ambiguous. */
  projectPath: string;
  cwd?: string;
  /** True when `cwd` still exists on disk. Many worktree cwds have been cleaned up. */
  cwdExists: boolean;
  /** `cwd` with a `.claude/worktrees/<name>` suffix stripped, for grouping by repo. */
  repoRoot?: string;
  repoRootExists: boolean;
  gitBranch?: string;
  title?: string;

  lastUserMessage?: string;
  lastUserMessageSource: TranscriptFacts['lastUserMessageSource'];
  lastAssistantText?: string;
  lastToolName?: string;
  lastToolAt?: string;

  messageCount: number;
  models: string[];
  firstTimestamp?: string;
  lastTimestamp?: string;

  turnState: TurnState;
  /** Evidence for `turnState`, from the transcript alone. */
  turnStateSignal: string;
  activity: Activity;
  /** Evidence for `activity`, which also weighs file staleness and background agents. */
  activitySignal: string;
  /** Milliseconds since the transcript file last changed. */
  idleMs: number;
  /** Newest mtime under `<sessionId>/subagents/`, when that directory exists. */
  subagentMtimeMs?: number;
  /**
   * A background subagent has written more recently than the session's own transcript.
   * The main transcript cannot see subagent work at all, so without this a session that
   * dispatched background agents reads as `awaiting-user` while work is still in flight.
   */
  backgroundAgentActive: boolean;

  prNumber?: number;
  prUrl?: string;
  prRepository?: string;
  mode?: string;
  permissionMode?: string;
  tokens: TranscriptFacts['tokens'];

  skippedLines: number;
  recordCount: number;
  fileSize: number;
  windowTruncated: boolean;
  sessionIdMismatch: boolean;
  mtimeMs: number;
}

export interface ScanStats {
  root: string;
  windowMs: number;
  /** Every `.jsonl` at depth 2, session-named or not. */
  filesAtDepth2: number;
  /** Depth-2 files rejected by the uuid-basename allowlist. */
  nonSessionFilesAtDepth2: number;
  /** Session files whose mtime fell inside the window. */
  matched: number;
  /** Session files outside the window. */
  outsideWindow: number;
  parsed: number;
  failed: number;
  projectDirs: number;
  bytesRead: number;
  recordsRead: number;
  skippedLines: number;
  /** Skipped lines as a fraction of records + skipped lines. */
  malformedRate: number;
  walkMs: number;
  parseMs: number;
  totalMs: number;
}

export interface ScanDrift {
  hasDrift: boolean;
  unknownTypes: Record<string, number>;
  unknownKeys: Record<string, number>;
  unknownVersions: Record<string, number>;
  /** First sighting of each distinct unknown type/key/version across the whole scan. */
  firstSightings: DriftSighting[];
}

export interface ScanError {
  filePath: string;
  error: string;
}

export interface ScanResult {
  sessions: SessionSummary[];
  stats: ScanStats;
  drift: ScanDrift;
  errors: ScanError[];
}

export interface ScanOptions {
  root?: string;
  /** Keep sessions whose file mtime is within this many ms of `now`. Default 7 days. */
  windowMs?: number;
  /** Cap on returned sessions, applied after sorting by last activity. */
  limit?: number;
  tailBytes?: number;
  maxTextChars?: number;
  /** Injectable clock, so tests are not time-dependent. */
  now?: number;
  /** A `mid-turn` session whose file has not moved in this long is reported `stalled`. Default 5 min. */
  stalledAfterMs?: number;
  /**
   * Also stat `<sessionId>/subagents/**` to detect background agent work the main transcript
   * cannot see. Default true; costs ~13 ms for 110 subagent directories.
   */
  checkSubagents?: boolean;
}

/** Newest mtime of any `.jsonl` under a session's `subagents/` directory, or 0 if there is none. */
function newestSubagentMtime(root: string, projectDir: string, sessionId: string): number {
  const start = join(root, projectDir, sessionId, 'subagents');
  let newest = 0;
  const stack: string[] = [start];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) { stack.push(p); continue; }
      if (!ent.name.endsWith('.jsonl')) continue;
      try {
        const m = statSync(p).mtimeMs;
        if (m > newest) newest = m;
      } catch { /* raced with a delete; ignore */ }
    }
  }
  return newest;
}

/**
 * List every session transcript: exactly `<root>/<projectDir>/<uuid>.jsonl`.
 * Anything deeper is a subagent or workflow transcript and is not a session.
 */
export function listSessionFiles(root: string = DEFAULT_ROOT): {
  files: SessionFileRef[];
  filesAtDepth2: number;
  nonSessionFilesAtDepth2: number;
  projectDirs: number;
} {
  const files: SessionFileRef[] = [];
  let filesAtDepth2 = 0;
  let nonSessionFilesAtDepth2 = 0;
  let projectDirs = 0;

  let projects: Dirent[];
  try {
    projects = readdirSync(root, { withFileTypes: true });
  } catch {
    return { files, filesAtDepth2, nonSessionFilesAtDepth2, projectDirs };
  }

  for (const projEnt of projects) {
    if (!projEnt.isDirectory()) continue;
    projectDirs++;
    const projectDir = projEnt.name;
    const dirPath = join(root, projectDir);
    let entries: Dirent[];
    try {
      entries = readdirSync(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith('.jsonl')) continue;
      filesAtDepth2++;
      if (!isSessionFileName(ent.name)) { nonSessionFilesAtDepth2++; continue; }
      const filePath = join(dirPath, ent.name);
      let st;
      try {
        st = statSync(filePath);
      } catch {
        continue;
      }
      files.push({
        filePath,
        projectDir,
        sessionId: ent.name.slice(0, -'.jsonl'.length),
        size: st.size,
        mtimeMs: st.mtimeMs,
      });
    }
  }
  return { files, filesAtDepth2, nonSessionFilesAtDepth2, projectDirs };
}

function toSummary(
  facts: TranscriptFacts,
  ref: SessionFileRef,
  now: number,
  stalledAfterMs: number,
  subagentMtimeMs: number,
): SessionSummary {
  const idleMs = Math.max(0, now - ref.mtimeMs);
  const backgroundAgentActive =
    subagentMtimeMs > ref.mtimeMs && now - subagentMtimeMs <= stalledAfterMs;

  let activity: Activity;
  let activitySignal: string;
  if (facts.turnState === 'mid-turn') {
    activity = idleMs > stalledAfterMs ? 'stalled' : 'running';
    activitySignal = idleMs > stalledAfterMs
      ? `mid-turn but the transcript has not moved for ${Math.round(idleMs / 1000)}s`
      : 'mid-turn and the transcript is still moving';
  } else if (backgroundAgentActive) {
    activity = 'running';
    activitySignal = 'a background subagent transcript is newer than this session\'s own';
  } else if (facts.turnState === 'awaiting-user') {
    activity = 'awaiting-user';
    activitySignal = facts.turnStateSignal;
  } else {
    activity = 'unknown';
    activitySignal = facts.turnStateSignal;
  }

  return {
    // Identity comes from the filename; the in-file camelCase value is a cross-check only.
    sessionId: ref.sessionId,
    filePath: ref.filePath,
    projectDir: ref.projectDir,
    projectPath: decodeProjectDir(ref.projectDir),
    cwd: facts.cwd,
    cwdExists: facts.cwd ? existsSync(facts.cwd) : false,
    repoRoot: facts.repoRoot,
    repoRootExists: facts.repoRoot ? existsSync(facts.repoRoot) : false,
    gitBranch: facts.gitBranch,
    title: facts.title,
    lastUserMessage: facts.lastUserMessage,
    lastUserMessageSource: facts.lastUserMessageSource,
    lastAssistantText: facts.lastAssistantText,
    lastToolName: facts.lastToolName,
    lastToolAt: facts.lastToolAt,
    messageCount: facts.messageCount,
    models: facts.models,
    firstTimestamp: facts.firstTimestamp,
    lastTimestamp: facts.lastTimestamp,
    turnState: facts.turnState,
    turnStateSignal: facts.turnStateSignal,
    activity,
    activitySignal,
    idleMs,
    subagentMtimeMs: subagentMtimeMs > 0 ? subagentMtimeMs : undefined,
    backgroundAgentActive,
    prNumber: facts.prNumber,
    prUrl: facts.prUrl,
    prRepository: facts.prRepository,
    mode: facts.mode,
    permissionMode: facts.permissionMode,
    tokens: facts.tokens,
    skippedLines: facts.skippedLines,
    recordCount: facts.recordCount,
    fileSize: facts.fileSize,
    windowTruncated: facts.windowTruncated,
    sessionIdMismatch: facts.sessionIdMismatch,
    mtimeMs: ref.mtimeMs,
  };
}

/**
 * Scan recently active sessions. Synchronous and one-shot by design: on the real tree a 7-day
 * window completes in single-digit milliseconds, so there is nothing to amortise.
 */
export function scanRecent(opts: ScanOptions = {}): ScanResult {
  const t0 = Date.now();
  const root = opts.root ?? DEFAULT_ROOT;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const now = opts.now ?? Date.now();
  const tailBytes = opts.tailBytes ?? DEFAULT_TAIL_BYTES;
  const maxTextChars = opts.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
  const stalledAfterMs = opts.stalledAfterMs ?? 5 * 60 * 1000;
  const checkSubagents = opts.checkSubagents ?? true;

  const listed = listSessionFiles(root);
  const walkMs = Date.now() - t0;

  const cutoff = now - windowMs;
  const matched = listed.files.filter((f) => f.mtimeMs >= cutoff);
  matched.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const selected = typeof opts.limit === 'number' ? matched.slice(0, Math.max(0, opts.limit)) : matched;

  const tParse = Date.now();
  const sessions: SessionSummary[] = [];
  const errors: ScanError[] = [];
  const unknownTypes = new Map<string, number>();
  const unknownKeys = new Map<string, number>();
  const unknownVersions = new Map<string, number>();
  const firstSightings: DriftSighting[] = [];
  const seenSightings = new Set<string>();
  let bytesRead = 0;
  let recordsRead = 0;
  let skippedLines = 0;

  for (const ref of selected) {
    let facts: TranscriptFacts;
    try {
      facts = parseTranscriptTail(ref.filePath, { tailBytes, maxTextChars });
    } catch (err) {
      errors.push({ filePath: ref.filePath, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    bytesRead += facts.windowBytes;
    recordsRead += facts.recordCount;
    skippedLines += facts.skippedLines;
    for (const [k, v] of Object.entries(facts.drift.unknownTypes)) unknownTypes.set(k, (unknownTypes.get(k) ?? 0) + v);
    for (const [k, v] of Object.entries(facts.drift.unknownKeys)) unknownKeys.set(k, (unknownKeys.get(k) ?? 0) + v);
    for (const [k, v] of Object.entries(facts.drift.unknownVersions)) unknownVersions.set(k, (unknownVersions.get(k) ?? 0) + v);
    for (const s of facts.drift.firstSightings) {
      const key = `${s.kind}:${s.onType ?? ''}:${s.name}`;
      if (seenSightings.has(key)) continue;
      seenSightings.add(key);
      firstSightings.push(s);
    }
    const subMtime = checkSubagents ? newestSubagentMtime(root, ref.projectDir, ref.sessionId) : 0;
    sessions.push(toSummary(facts, ref, now, stalledAfterMs, subMtime));
  }

  // Last activity: newest of the transcript's own newest timestamp and the file mtime. Sidecar
  // records (last-prompt, custom-title, mode) carry no timestamp, so mtime moves without any
  // timestamped record moving. Neither source alone is sufficient.
  sessions.sort((a, b) => {
    const av = Math.max(a.mtimeMs, a.lastTimestamp ? Date.parse(a.lastTimestamp) : 0);
    const bv = Math.max(b.mtimeMs, b.lastTimestamp ? Date.parse(b.lastTimestamp) : 0);
    return bv - av;
  });

  const parseMs = Date.now() - tParse;
  const denom = recordsRead + skippedLines;

  return {
    sessions,
    stats: {
      root,
      windowMs,
      filesAtDepth2: listed.filesAtDepth2,
      nonSessionFilesAtDepth2: listed.nonSessionFilesAtDepth2,
      matched: matched.length,
      outsideWindow: listed.files.length - matched.length,
      parsed: sessions.length,
      failed: errors.length,
      projectDirs: listed.projectDirs,
      bytesRead,
      recordsRead,
      skippedLines,
      malformedRate: denom > 0 ? skippedLines / denom : 0,
      walkMs,
      parseMs,
      totalMs: Date.now() - t0,
    },
    drift: {
      hasDrift: unknownTypes.size > 0 || unknownKeys.size > 0 || unknownVersions.size > 0,
      unknownTypes: Object.fromEntries(unknownTypes),
      unknownKeys: Object.fromEntries(unknownKeys),
      unknownVersions: Object.fromEntries(unknownVersions),
      firstSightings,
    },
    errors,
  };
}
