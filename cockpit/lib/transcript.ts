/**
 * transcript.ts — pure Claude Code JSONL transcript parser.
 *
 * Contract: give it a file path, it tail-reads at most `tailBytes` (default 64 KB) and returns
 * extracted facts. No resume position, no persistence, no globals, no SQLite. The only side effect
 * is reading the one file it was handed.
 *
 * Every schema decision here is grounded in ./SCHEMA-NOTES.md, which records the measurements.
 * The short version of what governs this file:
 *   - Split on 0x0A only. `node:readline` also splits on U+2028/U+2029, which occur inside JSON
 *     string values, and shreds valid records into invalid fragments.
 *   - Every field is optional. Unknown `type` values and unknown top-level keys are counted and
 *     reported as drift, never thrown on.
 *   - Format drift arrives as a NEW VALID TYPE or a renamed field, not as broken JSON. The
 *     malformed counter is kept honest but the drift report is the real signal.
 *   - `sessionId` (camelCase) is the identity. `session_id` (snake_case) also exists on newer
 *     writer versions and holds a DIFFERENT uuid. Never case-normalize keys.
 */

import { openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { basename, dirname, sep } from 'node:path';

// ---------------------------------------------------------------------------
// Known-schema baseline, for drift detection.
// Generated from every depth-2 session transcript on disk on 2026-08-21
// (155 files, 107,528 records, writer versions 2.1.181 … 2.1.228).
// ---------------------------------------------------------------------------

export const KNOWN_TYPES: readonly string[] = [
  'agent-name', 'ai-title', 'assistant', 'attachment', 'custom-title',
  'file-history-delta', 'file-history-snapshot', 'frame-link', 'last-prompt',
  'mode', 'permission-mode', 'pr-link', 'queue-operation', 'system', 'user',
];

export const KNOWN_VERSIONS: readonly string[] = [
  '2.1.181', '2.1.187', '2.1.197', '2.1.205', '2.1.209', '2.1.215', '2.1.217',
  '2.1.219', '2.1.220', '2.1.221', '2.1.222', '2.1.226', '2.1.227', '2.1.228',
];

export const KNOWN_KEYS: Readonly<Record<string, readonly string[]>> = {
  'agent-name': ['agentName', 'sessionId', 'type'],
  'ai-title': ['aiTitle', 'sessionId', 'type'],
  'assistant': ['apiErrorStatus', 'attributionAgent', 'attributionMcpServer', 'attributionMcpTool',
    'attributionPlugin', 'attributionSkill', 'agentId', 'cwd', 'effort', 'entrypoint', 'error',
    'errorDetails', 'gitBranch', 'isApiErrorMessage', 'isSidechain', 'message', 'parentUuid',
    'requestId', 'sessionId', 'sessionKind', 'session_id', 'slug', 'timestamp', 'type', 'userType',
    'uuid', 'version'],
  'attachment': ['agentId', 'attachment', 'cwd', 'entrypoint', 'gitBranch', 'isSidechain',
    'parentUuid', 'sessionId', 'sessionKind', 'session_id', 'slug', 'timestamp', 'type', 'userType',
    'uuid', 'version'],
  'custom-title': ['customTitle', 'sessionId', 'type'],
  'file-history-delta': ['backup', 'messageId', 'snapshotMessageId', 'timestamp', 'trackingPath', 'type'],
  'file-history-snapshot': ['isSnapshotUpdate', 'messageId', 'snapshot', 'type'],
  'frame-link': ['frameUrl', 'path', 'sessionId', 'timestamp', 'title', 'type'],
  'last-prompt': ['lastPrompt', 'leafUuid', 'sessionId', 'type'],
  'mode': ['mode', 'sessionId', 'type'],
  'permission-mode': ['permissionMode', 'sessionId', 'type'],
  'pr-link': ['prNumber', 'prRepository', 'prUrl', 'sessionId', 'timestamp', 'type'],
  'queue-operation': ['content', 'operation', 'sessionId', 'timestamp', 'type'],
  'system': ['content', 'cwd', 'durationMs', 'entrypoint', 'error', 'gitBranch', 'hasOutput',
    'hookAdditionalContext', 'hookCount', 'hookErrors', 'hookInfos', 'isMeta', 'isSidechain',
    'level', 'maxRetries', 'messageCount', 'parentUuid', 'preventedContinuation', 'retryAttempt',
    'retryInMs', 'sessionId', 'sessionKind', 'slug', 'source', 'stopReason', 'subtype', 'timestamp',
    'toolUseID', 'type', 'userType', 'uuid', 'version'],
  'user': ['agentId', 'classifierMetaLines', 'cwd', 'entrypoint', 'gitBranch',
    'interruptedByShutdown', 'interruptedMessageId', 'isMeta', 'isSidechain', 'mcpMeta', 'message',
    'origin', 'parentUuid', 'permissionMode', 'promptId', 'promptSource', 'sessionId', 'sessionKind',
    'session_id', 'slug', 'sourceToolAssistantUUID', 'sourceToolUseID', 'timestamp',
    'toolDenialKind', 'toolUseResult', 'type', 'userType', 'uuid', 'version'],
};

const KNOWN_TYPE_SET = new Set(KNOWN_TYPES);
const KNOWN_VERSION_SET = new Set(KNOWN_VERSIONS);
const KNOWN_KEY_SETS: Record<string, Set<string>> = Object.fromEntries(
  Object.entries(KNOWN_KEYS).map(([t, ks]) => [t, new Set(ks)]),
);

/** A session transcript is exactly `<root>/<encoded-project>/<uuid>.jsonl` — depth 2, uuid basename. */
export const SESSION_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

/**
 * Machine-generated `user` text that is not a human prompt. Used only by the fallback path;
 * the primary source for "most recent request" is the `last-prompt` record.
 */
const NON_HUMAN_PROMPT_PREFIXES = [
  '<task-notification>', '<command-name>', '<system-reminder>',
  '<local-command-stdout>', '<cross-session-message>', '<command-message>',
];

/** `<synthetic>` is a real value on client-generated assistant records. It is not a model. */
export const SYNTHETIC_MODEL = '<synthetic>';

export const DEFAULT_TAIL_BYTES = 64 * 1024;
export const DEFAULT_MAX_TEXT_CHARS = 2000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TurnState = 'mid-turn' | 'awaiting-user' | 'unknown';

export interface DriftSighting {
  kind: 'type' | 'key' | 'version';
  /** The unknown type name, key name, or version string. */
  name: string;
  /** For `kind: 'key'`, the record type the key appeared on. */
  onType?: string;
  filePath: string;
  /** Index of the record within the parsed tail window (0-based). */
  recordIndex: number;
  timestamp?: string;
}

export interface DriftReport {
  hasDrift: boolean;
  unknownTypes: Record<string, number>;
  unknownKeys: Record<string, number>;
  unknownVersions: Record<string, number>;
  /** One entry per distinct unknown thing, at the first record where it was seen. */
  firstSightings: DriftSighting[];
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface TranscriptFacts {
  filePath: string;
  /** Basename minus `.jsonl`. Authoritative identity per SCHEMA-NOTES §1. */
  sessionIdFromFilename?: string;
  /** camelCase `sessionId` from the records. Never the snake_case `session_id`. */
  sessionId?: string;
  /** True when the in-file camelCase sessionId disagrees with the filename. */
  sessionIdMismatch: boolean;
  /** Encoded project directory name (parent dir of the transcript). */
  projectDir?: string;

  cwd?: string;
  /** `cwd` with any `.../.claude/worktrees/<name>` suffix stripped, so worktrees group by repo. */
  repoRoot?: string;
  gitBranch?: string;

  title?: string;
  titleSource?: 'custom-title' | 'ai-title';

  /** Most recent user request. */
  lastUserMessage?: string;
  lastUserMessageSource: 'last-prompt' | 'user-record' | 'none';
  lastAssistantText?: string;
  lastToolName?: string;
  lastToolAt?: string;

  /** user + assistant records seen inside the tail window. Records, not turns. */
  messageCount: number;
  userCount: number;
  assistantCount: number;

  models: string[];
  versions: string[];
  entrypoints: string[];

  firstTimestamp?: string;
  lastTimestamp?: string;

  turnState: TurnState;
  /** Human-readable description of the evidence that produced `turnState`. */
  turnStateSignal: string;
  lastStopReason?: string;

  prNumber?: number;
  prUrl?: string;
  prRepository?: string;
  mode?: string;
  permissionMode?: string;

  tokens: TokenTotals;

  /** Lines inside the window that were neither parseable JSON nor an expected partial. */
  skippedLines: number;
  /** Records successfully parsed from the window. */
  recordCount: number;

  fileSize: number;
  windowStart: number;
  windowBytes: number;
  /** True when the window did not reach byte 0 — i.e. facts describe a suffix of the session. */
  windowTruncated: boolean;
  /** A partial first line was discarded because the window started mid-record. Expected, not an error. */
  droppedPartialHead: boolean;
  /** A partial last line was discarded because the writer is mid-append. Expected, not an error. */
  droppedPartialTail: boolean;

  drift: DriftReport;
}

export interface ParseOptions {
  /** Max bytes to read from the end of the file. Default 64 KB. */
  tailBytes?: number;
  /** Max characters retained per stored text field. Default 2000. */
  maxTextChars?: number;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function clip(v: string, max: number): string {
  return v.length <= max ? v : v.slice(0, max) + '…';
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Resolve a stable repo identity from a cwd.
 * Claude Code worktrees live at `<repo>/.claude/worktrees/<name>`; 64 of 95 recently active
 * project dirs point at worktrees that have since been cleaned up. Walking up past the
 * `.claude/worktrees/<name>` segment groups those sessions under the repo they came from.
 * Pure string logic — does not touch the filesystem.
 */
export function resolveRepoRoot(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const parts = cwd.split(sep);
  for (let i = parts.length - 1; i >= 2; i--) {
    if (parts[i - 2] === '.claude' && parts[i - 1] === 'worktrees') {
      return parts.slice(0, i - 2).join(sep) || sep;
    }
  }
  return cwd;
}

/** Decode `~/.claude/projects` directory names back to a best-effort path. Lossy by design. */
export function decodeProjectDir(encoded: string): string {
  return encoded.startsWith('-') ? '/' + encoded.slice(1).replace(/-/g, '/') : encoded;
}

/** True when a basename is a session transcript (depth-2 uuid rule, SCHEMA-NOTES §1). */
export function isSessionFileName(name: string): boolean {
  return SESSION_FILE_RE.test(name);
}

/** Extract the flat text of an assistant message's `text` blocks. */
function assistantText(content: unknown): string | undefined {
  if (typeof content === 'string') return content || undefined;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (isPlainObject(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  const joined = parts.join('\n').trim();
  return joined.length > 0 ? joined : undefined;
}

/** True when a user record's content carries a tool_result block (i.e. it is tool output). */
function hasToolResult(content: unknown): boolean {
  return Array.isArray(content) && content.some((b) => isPlainObject(b) && b.type === 'tool_result');
}

/** Flat text of a user message, if it is text-shaped at all. */
function userText(content: unknown): string | undefined {
  if (typeof content === 'string') return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (isPlainObject(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  const joined = parts.join('\n').trim();
  return joined.length > 0 ? joined : undefined;
}

/**
 * Fallback human-prompt predicate, used only when a session's window has no `last-prompt` record.
 * Requires `promptSource` present, `isMeta` not true, no tool_result, and rejects the six known
 * machine-text wrappers. See SCHEMA-NOTES §5 for the cross-tab this is derived from.
 */
function isHumanPromptRecord(rec: Record<string, unknown>): boolean {
  if (rec.type !== 'user') return false;
  if (rec.isMeta === true) return false;
  if (rec.promptSource == null) return false;
  const msg = rec.message;
  if (!isPlainObject(msg)) return false;
  if (hasToolResult(msg.content)) return false;
  const origin = rec.origin;
  if (isPlainObject(origin) && origin.kind !== 'human') return false;
  const text = userText(msg.content);
  if (!text) return false;
  return !NON_HUMAN_PROMPT_PREFIXES.some((p) => text.startsWith(p));
}

// ---------------------------------------------------------------------------
// Tail reading
// ---------------------------------------------------------------------------

export interface TailWindow {
  text: string;
  fileSize: number;
  windowStart: number;
  windowBytes: number;
  windowTruncated: boolean;
}

/** Read at most the last `tailBytes` of a file. Empty/short files come back whole. */
export function readTail(filePath: string, tailBytes: number = DEFAULT_TAIL_BYTES): TailWindow {
  const fd = openSync(filePath, 'r');
  try {
    const fileSize = fstatSync(fd).size;
    const want = Math.max(0, Math.min(tailBytes, fileSize));
    const windowStart = fileSize - want;
    if (want === 0) {
      return { text: '', fileSize, windowStart, windowBytes: 0, windowTruncated: false };
    }
    const buf = Buffer.allocUnsafe(want);
    let filled = 0;
    while (filled < want) {
      const n = readSync(fd, buf, filled, want - filled, windowStart + filled);
      if (n <= 0) break;
      filled += n;
    }
    return {
      text: buf.subarray(0, filled).toString('utf8'),
      fileSize,
      windowStart,
      windowBytes: filled,
      windowTruncated: windowStart > 0,
    };
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

interface Accum {
  facts: TranscriptFacts;
  unknownTypes: Map<string, number>;
  unknownKeys: Map<string, number>;
  unknownVersions: Map<string, number>;
  sightings: DriftSighting[];
  seenSightings: Set<string>;
  modelSet: Set<string>;
  versionSet: Set<string>;
  entrypointSet: Set<string>;
  /** Record index of the newest assistant record. */
  lastAssistantIdx: number;
  /** Record index of the newest human prompt record. */
  lastHumanPromptIdx: number;
  /** Record index of the newest tool_result user record. */
  lastToolResultIdx: number;
  /** Newest non-null stop_reason and the record index it came from. */
  lastStopReasonIdx: number;
  /** Fallback prompt text, used only if no last-prompt record is present. */
  fallbackPrompt?: string;
  sawLastPrompt: boolean;
}

function emptyFacts(filePath: string): TranscriptFacts {
  return {
    filePath,
    sessionIdMismatch: false,
    lastUserMessageSource: 'none',
    messageCount: 0,
    userCount: 0,
    assistantCount: 0,
    models: [],
    versions: [],
    entrypoints: [],
    turnState: 'unknown',
    turnStateSignal: 'no records in window',
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    skippedLines: 0,
    recordCount: 0,
    fileSize: 0,
    windowStart: 0,
    windowBytes: 0,
    windowTruncated: false,
    droppedPartialHead: false,
    droppedPartialTail: false,
    drift: { hasDrift: false, unknownTypes: {}, unknownKeys: {}, unknownVersions: {}, firstSightings: [] },
  };
}

function sight(a: Accum, s: DriftSighting): void {
  const key = `${s.kind}:${s.onType ?? ''}:${s.name}`;
  if (a.seenSightings.has(key)) return;
  a.seenSightings.add(key);
  a.sightings.push(s);
}

function applyRecord(a: Accum, rec: Record<string, unknown>, idx: number, maxTextChars: number): void {
  const f = a.facts;
  const type = typeof rec.type === 'string' ? rec.type : undefined;
  const timestamp = asString(rec.timestamp);
  const typeKey = type ?? '(no type key)';

  // --- drift ---------------------------------------------------------------
  if (type === undefined || !KNOWN_TYPE_SET.has(type)) {
    a.unknownTypes.set(typeKey, (a.unknownTypes.get(typeKey) ?? 0) + 1);
    sight(a, { kind: 'type', name: typeKey, filePath: f.filePath, recordIndex: idx, timestamp });
  } else {
    const known = KNOWN_KEY_SETS[type];
    for (const k of Object.keys(rec)) {
      if (!known.has(k)) {
        const label = `${type}.${k}`;
        a.unknownKeys.set(label, (a.unknownKeys.get(label) ?? 0) + 1);
        sight(a, { kind: 'key', name: k, onType: type, filePath: f.filePath, recordIndex: idx, timestamp });
      }
    }
  }
  const version = asString(rec.version);
  if (version) {
    a.versionSet.add(version);
    if (!KNOWN_VERSION_SET.has(version)) {
      a.unknownVersions.set(version, (a.unknownVersions.get(version) ?? 0) + 1);
      sight(a, { kind: 'version', name: version, filePath: f.filePath, recordIndex: idx, timestamp });
    }
  }

  // --- identity and context (camelCase sessionId ONLY) ---------------------
  const sid = asString(rec.sessionId);
  if (sid && !f.sessionId) f.sessionId = sid;

  const cwd = asString(rec.cwd);
  if (cwd) {
    f.cwd = cwd;
    f.repoRoot = resolveRepoRoot(cwd);
  }
  if (typeof rec.gitBranch === 'string' && rec.gitBranch.length > 0) f.gitBranch = rec.gitBranch;
  const entrypoint = asString(rec.entrypoint);
  if (entrypoint) a.entrypointSet.add(entrypoint);

  if (timestamp) {
    if (!f.firstTimestamp || timestamp < f.firstTimestamp) f.firstTimestamp = timestamp;
    if (!f.lastTimestamp || timestamp > f.lastTimestamp) f.lastTimestamp = timestamp;
  }

  // --- per-type extraction -------------------------------------------------
  switch (type) {
    case 'assistant': {
      f.assistantCount++;
      f.messageCount++;
      a.lastAssistantIdx = idx;
      const msg = rec.message;
      if (!isPlainObject(msg)) break;
      const model = asString(msg.model);
      if (model && model !== SYNTHETIC_MODEL) a.modelSet.add(model);
      const stop = asString(msg.stop_reason);
      if (stop) {
        f.lastStopReason = stop;
        a.lastStopReasonIdx = idx;
      }
      const usage = msg.usage;
      if (isPlainObject(usage)) {
        f.tokens.input += num(usage.input_tokens);
        f.tokens.output += num(usage.output_tokens);
        f.tokens.cacheRead += num(usage.cache_read_input_tokens);
        f.tokens.cacheCreation += num(usage.cache_creation_input_tokens);
      }
      const text = assistantText(msg.content);
      if (text) f.lastAssistantText = clip(text, maxTextChars);
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (isPlainObject(block) && block.type === 'tool_use') {
            const name = asString(block.name);
            if (name) {
              f.lastToolName = name;
              if (timestamp) f.lastToolAt = timestamp;
            }
          }
        }
      }
      break;
    }
    case 'user': {
      f.userCount++;
      f.messageCount++;
      const msg = rec.message;
      if (isPlainObject(msg) && hasToolResult(msg.content)) a.lastToolResultIdx = idx;
      if (isHumanPromptRecord(rec)) {
        a.lastHumanPromptIdx = idx;
        const text = isPlainObject(msg) ? userText(msg.content) : undefined;
        if (text) a.fallbackPrompt = clip(text, maxTextChars);
      }
      break;
    }
    case 'last-prompt': {
      const p = asString(rec.lastPrompt);
      if (p) {
        f.lastUserMessage = clip(p, maxTextChars);
        f.lastUserMessageSource = 'last-prompt';
        a.sawLastPrompt = true;
      }
      break;
    }
    case 'custom-title': {
      const t = asString(rec.customTitle);
      if (t) { f.title = clip(t, maxTextChars); f.titleSource = 'custom-title'; }
      break;
    }
    case 'ai-title': {
      const t = asString(rec.aiTitle);
      // A user-set custom title outranks a generated one.
      if (t && f.titleSource !== 'custom-title') { f.title = clip(t, maxTextChars); f.titleSource = 'ai-title'; }
      break;
    }
    case 'pr-link': {
      if (typeof rec.prNumber === 'number') f.prNumber = rec.prNumber;
      const url = asString(rec.prUrl);
      if (url) f.prUrl = url;
      const repo = asString(rec.prRepository);
      if (repo) f.prRepository = repo;
      break;
    }
    case 'mode': {
      const m = asString(rec.mode);
      if (m) f.mode = m;
      break;
    }
    case 'permission-mode': {
      const m = asString(rec.permissionMode);
      if (m) f.permissionMode = m;
      break;
    }
    default:
      break;
  }
}

/**
 * Decide mid-turn vs awaiting-user from the window alone.
 *
 * Evidence (SCHEMA-NOTES §11, measured across 155 session transcripts):
 *   - `stop_reason` on the newest `assistant` record is the signal. `tool_use` means the model
 *     asked for a tool and will be called again; `end_turn` / `stop_sequence` / `max_tokens` mean
 *     the turn completed.
 *   - A human prompt record newer than the newest assistant record means the user has spoken and
 *     the model has not answered yet — also mid-turn.
 *   - `stop_reason: null` appeared on 1 of 49,171 assistant records and was never the newest one,
 *     but the newest non-null value is carried forward anyway.
 */
function decideTurnState(a: Accum): void {
  const f = a.facts;
  if (a.lastHumanPromptIdx > a.lastAssistantIdx && a.lastHumanPromptIdx >= 0) {
    f.turnState = 'mid-turn';
    f.turnStateSignal = 'a human prompt is newer than the newest assistant record';
    return;
  }
  if (a.lastAssistantIdx < 0) {
    f.turnState = 'unknown';
    f.turnStateSignal = f.recordCount === 0
      ? 'no records in window'
      : 'no assistant record in window';
    return;
  }
  const stop = f.lastStopReason;
  if (stop === 'tool_use') {
    f.turnState = 'mid-turn';
    f.turnStateSignal = a.lastToolResultIdx > a.lastStopReasonIdx
      ? 'newest assistant stop_reason=tool_use, tool result returned, model not yet re-entered'
      : 'newest assistant stop_reason=tool_use, tool still running';
    return;
  }
  if (stop === 'end_turn' || stop === 'stop_sequence' || stop === 'max_tokens') {
    f.turnState = 'awaiting-user';
    f.turnStateSignal = `newest assistant stop_reason=${stop}`;
    return;
  }
  f.turnState = 'unknown';
  f.turnStateSignal = stop ? `unrecognised stop_reason=${stop}` : 'no stop_reason on any assistant record in window';
}

/**
 * Parse a tail window of transcript text. Exported so tests can drive the parser without a file.
 *
 * @param windowTruncated whether the window began mid-file, which makes a partial first line expected.
 */
export function parseTailText(
  text: string,
  filePath: string,
  windowTruncated: boolean,
  opts: ParseOptions = {},
): TranscriptFacts {
  const maxTextChars = opts.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
  const facts = emptyFacts(filePath);
  facts.windowTruncated = windowTruncated;

  const name = basename(filePath);
  if (isSessionFileName(name)) facts.sessionIdFromFilename = name.slice(0, -'.jsonl'.length);
  const parent = basename(dirname(filePath));
  if (parent) facts.projectDir = parent;

  const a: Accum = {
    facts,
    unknownTypes: new Map(), unknownKeys: new Map(), unknownVersions: new Map(),
    sightings: [], seenSightings: new Set(),
    modelSet: new Set(), versionSet: new Set(), entrypointSet: new Set(),
    lastAssistantIdx: -1, lastHumanPromptIdx: -1, lastToolResultIdx: -1, lastStopReasonIdx: -1,
    sawLastPrompt: false,
  };

  const lines = text.split('\n');
  // The final element is the trailing fragment: '' when the text ended on a newline, otherwise a
  // line the writer has not finished appending.
  const trailing = lines.pop() ?? '';

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A window that began mid-file starts on a partial record. Expected, not malformed.
      if (i === 0 && windowTruncated) { facts.droppedPartialHead = true; continue; }
      facts.skippedLines++;
      continue;
    }
    if (!isPlainObject(parsed)) {
      if (i === 0 && windowTruncated) { facts.droppedPartialHead = true; continue; }
      facts.skippedLines++;
      continue;
    }
    applyRecord(a, parsed, facts.recordCount, maxTextChars);
    facts.recordCount++;
  }

  // Trailing fragment: the writer may be mid-append. Try it; if it parses it is a complete record
  // that simply lacked a newline, otherwise drop it without counting it as malformed.
  if (trailing.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trailing);
    } catch {
      parsed = undefined;
    }
    if (isPlainObject(parsed)) {
      applyRecord(a, parsed, facts.recordCount, maxTextChars);
      facts.recordCount++;
    } else {
      facts.droppedPartialTail = true;
    }
  }

  if (!a.sawLastPrompt && a.fallbackPrompt) {
    facts.lastUserMessage = a.fallbackPrompt;
    facts.lastUserMessageSource = 'user-record';
  }

  facts.models = [...a.modelSet].sort();
  facts.versions = [...a.versionSet].sort();
  facts.entrypoints = [...a.entrypointSet].sort();
  facts.sessionIdMismatch = Boolean(
    facts.sessionId && facts.sessionIdFromFilename && facts.sessionId !== facts.sessionIdFromFilename,
  );

  decideTurnState(a);

  facts.drift = {
    hasDrift: a.unknownTypes.size > 0 || a.unknownKeys.size > 0 || a.unknownVersions.size > 0,
    unknownTypes: Object.fromEntries(a.unknownTypes),
    unknownKeys: Object.fromEntries(a.unknownKeys),
    unknownVersions: Object.fromEntries(a.unknownVersions),
    firstSightings: a.sightings,
  };
  return facts;
}

/**
 * Tail-read a transcript file and extract facts. The only public entry point most callers need.
 * Throws only if the file cannot be opened; every content problem is reported in the return value.
 */
export function parseTranscriptTail(filePath: string, opts: ParseOptions = {}): TranscriptFacts {
  const win = readTail(filePath, opts.tailBytes ?? DEFAULT_TAIL_BYTES);
  const facts = parseTailText(win.text, filePath, win.windowTruncated, opts);
  facts.fileSize = win.fileSize;
  facts.windowStart = win.windowStart;
  facts.windowBytes = win.windowBytes;
  return facts;
}
