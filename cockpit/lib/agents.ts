/**
 * Liveness over `claude agents --json --all`.
 *
 * This is the authoritative answer to "is this session's process alive right now".
 * It needs no TTY, no hooks, and no inference from file mtimes.
 *
 * Verified 2026-08-21 on Claude Code 2.1.228:
 *   claude agents --json --all
 *   -> [{ pid, cwd, kind: "interactive", startedAt, sessionId, name },
 *       { id, cwd, kind: "background", startedAt, sessionId, name, state: "done" }]
 *
 * Nothing here throws. The board must still render when this command is missing,
 * renamed, or slow, because it is an undocumented surface that a Claude Code
 * update can change without notice.
 */

import { execFile } from "node:child_process";

export type LiveSession = {
  sessionId: string;
  cwd: string;
  /** "interactive" is a session someone is sitting in; "background" is a dispatched agent. */
  kind: string;
  /** epoch ms */
  startedAt: number;
  name: string;
  /** Present on interactive sessions. Its presence is what "alive" means. */
  pid?: number;
  /** Present on background sessions, e.g. "done". */
  state?: string;
  /** Short id, present on background sessions. */
  id?: string;
};

export type LivenessResult = {
  sessions: LiveSession[];
  /** Set when the command could not be trusted. Callers should degrade, not fail. */
  error?: string;
  /** Wall-clock ms, so the board can show when this surface gets slow. */
  ms: number;
};

const TIMEOUT_MS = 5_000;

function run(args: string[], timeout: number): Promise<{ stdout: string; error?: string }> {
  return new Promise((resolve) => {
    execFile(
      "claude",
      args,
      { timeout, maxBuffer: 8 * 1024 * 1024, killSignal: "SIGKILL" },
      (err, stdout, stderr) => {
        if (err) {
          const reason =
            (err as NodeJS.ErrnoException).code === "ENOENT"
              ? "`claude` not found on PATH"
              : err.message || String(err);
          resolve({ stdout: stdout ?? "", error: `${reason}${stderr ? ` — ${stderr.trim()}` : ""}` });
          return;
        }
        resolve({ stdout: stdout ?? "" });
      },
    );
  });
}

/** Coerce one entry defensively. Unknown shapes are dropped rather than trusted. */
function toLiveSession(raw: unknown): LiveSession | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const sessionId = typeof r.sessionId === "string" ? r.sessionId : null;
  if (!sessionId) return null;
  return {
    sessionId,
    cwd: typeof r.cwd === "string" ? r.cwd : "",
    kind: typeof r.kind === "string" ? r.kind : "unknown",
    startedAt: typeof r.startedAt === "number" ? r.startedAt : 0,
    name: typeof r.name === "string" ? r.name : sessionId.slice(0, 8),
    pid: typeof r.pid === "number" ? r.pid : undefined,
    state: typeof r.state === "string" ? r.state : undefined,
    id: typeof r.id === "string" ? r.id : undefined,
  };
}

/**
 * Read live sessions. Never throws.
 *
 * `includeCompleted` maps to --all, which adds finished background sessions.
 * Those are worth showing: a dispatched agent that finished is exactly the thing
 * the user wants to notice without opening anything.
 */
export async function readLiveSessions(includeCompleted = true): Promise<LivenessResult> {
  const started = Date.now();
  const args = includeCompleted ? ["agents", "--json", "--all"] : ["agents", "--json"];
  const { stdout, error } = await run(args, TIMEOUT_MS);
  const ms = Date.now() - started;

  if (error) return { sessions: [], error, ms };

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    const preview = stdout.slice(0, 120).replace(/\s+/g, " ").trim();
    return {
      sessions: [],
      error: `\`claude agents --json\` returned non-JSON${preview ? `: ${preview}` : ""}`,
      ms,
    };
  }

  if (!Array.isArray(parsed)) {
    return { sessions: [], error: "`claude agents --json` did not return an array", ms };
  }

  const sessions = parsed.map(toLiveSession).filter((s): s is LiveSession => s !== null);

  // A shape change that silently drops everything should be visible, not quiet.
  const dropped = parsed.length - sessions.length;
  const shapeDrift =
    dropped > 0 ? `${dropped}/${parsed.length} entries had an unrecognized shape` : undefined;

  return { sessions, error: shapeDrift, ms };
}

/** True when this session has a live process behind it. */
export function isAlive(s: LiveSession): boolean {
  if (typeof s.pid === "number") return true;
  return s.state !== undefined && s.state !== "done" && s.state !== "failed";
}
