"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { FleetCard } from "@/lib/fleet";
import { dispatchRefusalMessage } from "./refusalText";

/** A session just started from this bar, rendered as a card immediately — before the fleet scan has caught up. */
export interface PendingSession {
  sessionId: string;
  cwd: string;
  repoLabel: string;
  prompt: string;
  /** The still-streaming Response from POST /api/dispatch, handed to SessionConsole to consume. */
  response: Response;
}

interface ProjectOption {
  cwd: string;
  label: string;
}

/** Distinct, existing cwds from the current fleet, labelled for the picker. Alphabetical by label. */
function projectOptions(cards: FleetCard[]): ProjectOption[] {
  const byCwd = new Map<string, ProjectOption>();
  for (const c of cards) {
    if (!c.cwdExists || !c.cwd || byCwd.has(c.cwd)) continue;
    byCwd.set(c.cwd, {
      cwd: c.cwd,
      label: c.worktreeName ? `${c.repoLabel} · ${c.worktreeName}` : c.repoLabel,
    });
  }
  return [...byCwd.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export default function DispatchBar({
  cards,
  onDispatched,
}: {
  cards: FleetCard[];
  onDispatched: (pending: PendingSession) => void;
}) {
  const [open, setOpen] = useState(false);
  const [cwd, setCwd] = useState("");
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; detail?: string } | null>(null);
  const options = useMemo(() => projectOptions(cards), [cards]);

  // Keep the selection valid as the fleet (and therefore the option list) changes underneath it.
  useEffect(() => {
    if (options.length === 0) return;
    if (!options.some((o) => o.cwd === cwd)) setCwd(options[0].cwd);
  }, [options, cwd]);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting || !cwd || prompt.trim() === "") return;
    setSubmitting(true);
    setError(null);

    let res: Response;
    try {
      res = await fetch("/api/dispatch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd, prompt }),
      });
    } catch (err) {
      setSubmitting(false);
      setError({
        message: "Could not reach the console.",
        detail: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // /api/dispatch always answers 200. Success is a streaming ndjson body; refusal is a JSON
    // `{ok:false, reason, detail}` body. The content-type is the only reliable way to tell them
    // apart — `ok` is never present in the body on the success path at all.
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("ndjson")) {
      const sessionId = res.headers.get("x-cockpit-session-id");
      if (!sessionId) {
        setSubmitting(false);
        setError({ message: "Could not start that session.", detail: "the server did not return a session id" });
        return;
      }
      const cwdHeader = res.headers.get("x-cockpit-cwd");
      const resolvedCwd = cwdHeader ? decodeURIComponent(cwdHeader) : cwd;
      const label = options.find((o) => o.cwd === resolvedCwd)?.label ?? resolvedCwd;
      onDispatched({ sessionId, cwd: resolvedCwd, repoLabel: label, prompt, response: res });
      setPrompt("");
      setSubmitting(false);
      setOpen(false);
      return;
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      /* fall through to the generic message below */
    }
    setSubmitting(false);
    setError({
      message: dispatchRefusalMessage(typeof body.reason === "string" ? body.reason : `http-${res.status}`),
      detail: typeof body.detail === "string" ? body.detail : undefined,
    });
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 transition-colors hover:bg-zinc-900 hover:text-zinc-200"
      >
        {open ? "cancel" : "+ new session"}
      </button>

      {open && (
        <form
          onSubmit={handleSubmit}
          className="flex w-full flex-wrap items-center justify-end gap-1.5 rounded border border-zinc-800 bg-zinc-900/60 p-2"
        >
          <select
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            disabled={submitting || options.length === 0}
            aria-label="Project"
            className="rounded border border-zinc-700 bg-zinc-950 px-1.5 py-1 text-xs text-zinc-200 disabled:opacity-50"
          >
            {options.length === 0 && <option value="">no projects available</option>}
            {options.map((o) => (
              <option key={o.cwd} value={o.cwd}>
                {o.label}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={submitting}
            placeholder="What should it do?"
            aria-label="Prompt"
            className="min-w-[220px] flex-1 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={submitting || !cwd || prompt.trim() === ""}
            className="shrink-0 rounded bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-40"
          >
            {submitting ? "starting…" : "start"}
          </button>
          {error && (
            <div role="alert" className="w-full rounded border border-amber-800/60 bg-amber-950/30 px-1.5 py-1 text-[11px] text-amber-200">
              <p>{error.message}</p>
              {error.detail && <p className="mt-0.5 text-[10px] text-amber-400/70">{error.detail}</p>}
            </div>
          )}
        </form>
      )}
    </div>
  );
}
