/**
 * Client-side NDJSON reader for `claude --output-format stream-json` output, as proxied verbatim
 * by POST /api/sessions/[id]/continue and POST /api/dispatch (see lib/dispatch.ts's `streamChild`
 * — the run's stream-json lines, then one trailing `cockpit_status` line).
 *
 * Only assistant text is surfaced to callers. Every other record type — `system`, `user` (tool
 * results), `assistant` tool_use/thinking blocks, the CLI's own final `result` summary — is
 * parsed only far enough to be safely skipped. the user is not a developer; he must never be shown a
 * raw stream-json line.
 */

export interface RunOutcome {
  code: number | null;
  signal: string | null;
  error?: string;
  stderr?: string;
}

export interface StreamCallbacks {
  /** Called with each new slice of assistant text as it arrives, in order. */
  onText: (chunk: string) => void;
  /** Called exactly once, when the stream ends. `outcome` is null if no `cockpit_status` line arrived. */
  onDone: (outcome: RunOutcome | null) => void;
}

function parseLine(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    // A malformed or partial line is never shown to the user as raw text — just dropped.
    return null;
  }
}

function isTextBlock(block: unknown): block is { type: "text"; text: string } {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as Record<string, unknown>).type === "text" &&
    typeof (block as Record<string, unknown>).text === "string"
  );
}

/** `assistant` -> `message.content[]` `type:"text"` -> `.text`, per lib/SCHEMA-NOTES.md §4. */
function assistantText(line: Record<string, unknown>): string {
  if (line.type !== "assistant") return "";
  const message = line.message;
  if (typeof message !== "object" || message === null) return "";
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (isTextBlock(block)) text += block.text;
  }
  return text;
}

/** The trailing status line `streamChild` (lib/dispatch.ts) always appends before closing the stream. */
function cockpitOutcome(line: Record<string, unknown>): RunOutcome | null {
  if (line.type !== "cockpit_status") return null;
  return {
    code: typeof line.code === "number" ? line.code : null,
    signal: typeof line.signal === "string" ? line.signal : null,
    error: typeof line.error === "string" ? line.error : undefined,
    stderr: typeof line.stderr === "string" ? line.stderr : undefined,
  };
}

function handleLine(raw: string, callbacks: StreamCallbacks, state: { outcome: RunOutcome | null }): void {
  const line = parseLine(raw);
  if (!line) return;
  const text = assistantText(line);
  if (text) callbacks.onText(text);
  const outcome = cockpitOutcome(line);
  if (outcome) state.outcome = outcome;
}

/**
 * Reads an NDJSON body to completion, invoking `onText` per assistant chunk and `onDone` exactly
 * once at the end. Never throws — a dropped connection mid-stream just ends the read early with
 * whatever outcome (possibly none) was captured so far.
 */
export async function consumeNdjsonStream(
  body: ReadableStream<Uint8Array> | null,
  callbacks: StreamCallbacks,
): Promise<void> {
  if (!body) {
    callbacks.onDone(null);
    return;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const state: { outcome: RunOutcome | null } = { outcome: null };
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const raw of lines) handleLine(raw, callbacks, state);
    }
    buffer += decoder.decode();
    if (buffer.trim()) handleLine(buffer, callbacks, state);
  } catch {
    /* connection dropped mid-stream; fall through and report whatever outcome was captured */
  } finally {
    callbacks.onDone(state.outcome);
  }
}
