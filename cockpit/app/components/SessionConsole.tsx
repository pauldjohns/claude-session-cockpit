"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { consumeNdjsonStream, type RunOutcome } from "./streamNdjson";
import { refusalView } from "./refusalText";

type Phase =
  | { kind: "idle" }
  | { kind: "running"; text: string }
  | { kind: "finished"; text: string; outcome: RunOutcome | null }
  | { kind: "refused"; reason: string; detail?: string; jumpUrl?: string };

export interface SessionConsoleProps {
  sessionId: string;
  /**
   * A run already in flight — the stream returned by a POST /api/dispatch this page just made —
   * to render immediately instead of waiting on the compose box. Consumed at most once per
   * mounted instance (see startedInitialRef below); further messages go through the normal
   * compose box and POST /api/sessions/[id]/continue like any other card.
   */
  initialRun?: { response: Response } | null;
  onInitialRunSettled?: () => void;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export default function SessionConsole({ sessionId, initialRun, onInitialRunSettled }: SessionConsoleProps) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [message, setMessage] = useState("");
  const mountedRef = useRef(true);
  const startedInitialRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!initialRun || startedInitialRef.current) return;
    startedInitialRef.current = true;
    setPhase({ kind: "running", text: "" });
    let text = "";
    void consumeNdjsonStream(initialRun.response.body, {
      onText: (chunk) => {
        text += chunk;
        if (mountedRef.current) setPhase({ kind: "running", text });
      },
      onDone: (outcome) => {
        if (mountedRef.current) setPhase({ kind: "finished", text, outcome });
        onInitialRunSettled?.();
      },
    });
    // Deliberately runs at most once per mounted instance, guarded by startedInitialRef above —
    // not re-triggered by prop identity churn from the parent re-rendering.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (phase.kind === "running") return;
    const toSend = message;
    if (toSend.trim() === "") return;

    setPhase({ kind: "running", text: "" });

    let res: Response;
    try {
      res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/continue`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: toSend }),
      });
    } catch (err) {
      if (mountedRef.current) {
        setPhase({
          kind: "refused",
          reason: "network",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (!res.ok) {
      let body: Record<string, unknown> = {};
      try {
        body = (await res.json()) as Record<string, unknown>;
      } catch {
        /* fall through to a generic refusal below */
      }
      if (mountedRef.current) {
        setPhase({
          kind: "refused",
          reason: typeof body.reason === "string" ? body.reason : `http-${res.status}`,
          detail: typeof body.detail === "string" ? body.detail : undefined,
          jumpUrl: typeof body.jumpUrl === "string" ? body.jumpUrl : undefined,
        });
      }
      return;
    }

    // Accepted: clear the box now (it's disabled anyway until the run finishes) so the next
    // message starts from empty.
    setMessage("");
    let text = "";
    await consumeNdjsonStream(res.body, {
      onText: (chunk) => {
        text += chunk;
        if (mountedRef.current) setPhase({ kind: "running", text });
      },
      onDone: (outcome) => {
        if (mountedRef.current) setPhase({ kind: "finished", text, outcome });
      },
    });
  }

  const running = phase.kind === "running";
  const view = phase.kind === "refused" ? refusalView(phase.reason) : null;
  const refusedDetail = phase.kind === "refused" ? phase.detail : undefined;
  const jumpHref =
    phase.kind === "refused"
      ? phase.jumpUrl ?? `claude://resume?session=${encodeURIComponent(sessionId)}`
      : undefined;
  const outputText = phase.kind === "running" || phase.kind === "finished" ? phase.text : "";
  const outcome = phase.kind === "finished" ? phase.outcome : null;

  return (
    <div className="mt-1 flex flex-col gap-1">
      {view && (
        <div
          role="alert"
          className={`rounded border px-1.5 py-1 text-[11px] ${
            view.prominentJump
              ? "border-sky-800/60 bg-sky-950/30 text-sky-200"
              : "border-amber-800/60 bg-amber-950/30 text-amber-200"
          }`}
        >
          <p>{view.message}</p>
          {view.prominentJump && (
            <a
              href={jumpHref}
              className="mt-1 inline-block rounded bg-sky-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-sky-500"
            >
              Open it in Claude
            </a>
          )}
          {view.showDetail && refusedDetail && (
            <p className="mt-0.5 text-[10px] text-amber-400/70">{truncate(refusedDetail, 200)}</p>
          )}
        </div>
      )}

      {(phase.kind === "running" || phase.kind === "finished") && (
        <div className="max-h-28 overflow-y-auto whitespace-pre-wrap rounded bg-zinc-950/60 px-1.5 py-1 text-[11px] text-zinc-300">
          {outputText || (
            <span className="text-zinc-600">{running ? "Claude is working…" : "(no reply text)"}</span>
          )}
          {outcome && (outcome.code !== 0 || outcome.signal || outcome.error) && (
            <div className="mt-1 border-t border-zinc-800 pt-1 text-[10px] text-red-400">
              Session exited with an error.
              {outcome.stderr && <div className="mt-0.5 text-zinc-500">{truncate(outcome.stderr, 200)}</div>}
            </div>
          )}
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex items-center gap-1">
        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          disabled={running}
          placeholder="Send a message…"
          aria-label="Message to send"
          className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-1 text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={running || message.trim() === ""}
          className="flex shrink-0 items-center justify-center rounded bg-zinc-800 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 disabled:opacity-40"
        >
          {running ? (
            <span
              className="h-3 w-3 animate-spin rounded-full border-2 border-zinc-500 border-t-transparent"
              aria-label="Sending"
            />
          ) : (
            "Send"
          )}
        </button>
      </form>
    </div>
  );
}
