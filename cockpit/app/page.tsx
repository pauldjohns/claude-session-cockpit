"use client";

import { useEffect, useMemo, useState } from "react";
// Type-only: lib/fleet.ts (and its own imports, lib/agents.ts + lib/scan.ts) touch node:fs and
// node:child_process. `import type` erases completely at compile time, so none of that runtime
// code ever reaches this client bundle. Never switch these to a value import.
import type { FleetCard, FleetResult, FleetStatus } from "@/lib/fleet";
import DispatchBar, { type PendingSession } from "./components/DispatchBar";
import SessionConsole from "./components/SessionConsole";

const POLL_MS = 5_000;

const WINDOW_OPTIONS: { label: string; ms: number }[] = [
  { label: "24h", ms: 24 * 60 * 60 * 1000 },
  { label: "7d", ms: 7 * 24 * 60 * 60 * 1000 },
  { label: "30d", ms: 30 * 24 * 60 * 60 * 1000 },
];
const DEFAULT_WINDOW_MS = WINDOW_OPTIONS[1].ms;

// Mirrors lib/fleet.ts's FLEET_STATUS_ORDER. Duplicated (not imported) on purpose — see the note
// on the import above. Waiting sorts first: it is "waiting on you."
const STATUS_ORDER: FleetStatus[] = ["waiting", "working", "stalled", "unknown", "done"];

const STATUS_META: Record<FleetStatus, { dot: string; pill: string; border: string; label: string }> = {
  waiting: { dot: "bg-emerald-400", pill: "bg-emerald-950/60 text-emerald-300", border: "border-l-emerald-500", label: "waiting" },
  working: { dot: "bg-sky-400", pill: "bg-sky-950/60 text-sky-300", border: "border-l-sky-500", label: "working" },
  stalled: { dot: "bg-red-400", pill: "bg-red-950/60 text-red-300", border: "border-l-red-500", label: "stalled" },
  unknown: { dot: "bg-amber-400", pill: "bg-amber-950/60 text-amber-300", border: "border-l-amber-500", label: "unknown" },
  done: { dot: "bg-zinc-500", pill: "bg-zinc-800/80 text-zinc-400", border: "border-l-zinc-700", label: "done" },
};

function isTemporaryCwd(cwd: string): boolean {
  return (
    cwd === "/tmp" ||
    cwd.startsWith("/tmp/") ||
    cwd === "/private/tmp" ||
    cwd.startsWith("/private/tmp/")
  );
}

function relativeTime(epochMs: number | undefined): string {
  if (!epochMs) return "unknown";
  const diffSec = Math.floor((Date.now() - epochMs) / 1000);
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

/** Collapses whitespace and clips to `max` chars. Never returns an empty string — undefined instead. */
function truncate(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function driftSummary(drift: FleetResult["drift"] | undefined): string {
  if (!drift?.hasDrift) return "";
  const parts: string[] = [];
  const types = Object.keys(drift.unknownTypes);
  const keys = Object.keys(drift.unknownKeys);
  const versions = Object.keys(drift.unknownVersions);
  if (types.length) parts.push(`${types.length} new type${types.length === 1 ? "" : "s"} (${types.join(", ")})`);
  if (keys.length) parts.push(`${keys.length} new key${keys.length === 1 ? "" : "s"} (${keys.join(", ")})`);
  if (versions.length) parts.push(`${versions.length} new writer version${versions.length === 1 ? "" : "s"} (${versions.join(", ")})`);
  return parts.join(" · ") || "unrecognized schema encountered";
}

type Group = { repoLabel: string; cards: FleetCard[]; lastActive: number };

/** Buckets by repoLabel without re-sorting — cards arrive pre-sorted (status, then recency) from the API. */
function groupCards(cards: FleetCard[]): Group[] {
  const groups = new Map<string, FleetCard[]>();
  for (const card of cards) {
    const bucket = groups.get(card.repoLabel);
    if (bucket) bucket.push(card);
    else groups.set(card.repoLabel, [card]);
  }
  const result: Group[] = Array.from(groups.entries()).map(([repoLabel, groupCards]) => ({
    repoLabel,
    cards: groupCards,
    lastActive: Math.max(...groupCards.map((c) => c.lastActivityAt)),
  }));
  result.sort((a, b) => b.lastActive - a.lastActive);
  return result;
}

function statusCounts(cards: FleetCard[]): Record<FleetStatus, number> {
  const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0])) as Record<FleetStatus, number>;
  for (const c of cards) counts[c.status]++;
  return counts;
}

export default function Home() {
  const [data, setData] = useState<FleetResult | null>(null);
  const [fetchError, setFetchError] = useState<string | undefined>(undefined);
  const [showTemporary, setShowTemporary] = useState(false);
  const [windowMs, setWindowMs] = useState(DEFAULT_WINDOW_MS);
  // Sessions started from the "+ new session" bar, shown as their own card immediately — before
  // the next fleet scan has a transcript to build a real card from. See the cleanup effect below.
  const [pendingSessions, setPendingSessions] = useState<PendingSession[]>([]);
  const [settledPending, setSettledPending] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch(`/api/fleet?windowMs=${windowMs}`, { cache: "no-store" });
        const json = (await res.json()) as FleetResult;
        if (cancelled) return;
        setData(json);
        setFetchError(undefined);
      } catch (err) {
        if (cancelled) return;
        setFetchError(err instanceof Error ? err.message : "Could not reach /api/fleet");
      }
    }

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [windowMs]);

  const cards = data?.cards ?? [];
  const aliveCount = cards.filter((c) => c.alive).length;
  const temporary = cards.filter((c) => isTemporaryCwd(c.cwd));
  // Pending cards render themselves (see below) — hide the matching real card so it doesn't
  // appear twice while both exist momentarily.
  const pendingIds = useMemo(() => new Set(pendingSessions.map((p) => p.sessionId)), [pendingSessions]);
  const visible = (showTemporary ? cards : cards.filter((c) => !isTemporaryCwd(c.cwd))).filter(
    (c) => !pendingIds.has(c.sessionId),
  );
  const groups = useMemo(() => groupCards(visible), [visible]);
  const counts = useMemo(() => statusCounts(visible), [visible]);
  const banner = data?.error ?? fetchError;
  const drift = driftSummary(data?.drift);
  const loading = !data && !fetchError;

  // A pending card graduates into a normal FleetCardView once the fleet scan has picked up its
  // transcript AND its own initial stream has finished — dropping it before the stream finishes
  // would blank out the live output the user is watching mid-run.
  useEffect(() => {
    if (pendingSessions.length === 0) return;
    const liveIds = new Set(cards.map((c) => c.sessionId));
    setPendingSessions((prev) =>
      prev.filter((p) => !(settledPending.has(p.sessionId) && liveIds.has(p.sessionId))),
    );
  }, [cards, settledPending]);

  function handleDispatched(pending: PendingSession) {
    setPendingSessions((prev) => [pending, ...prev.filter((p) => p.sessionId !== pending.sessionId)]);
  }

  function handlePendingSettled(sessionId: string) {
    setSettledPending((prev) => new Set(prev).add(sessionId));
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="mx-auto max-w-[1700px] px-4 py-3">
        <header className="mb-3 flex flex-col gap-2 border-b border-zinc-800 pb-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h1 className="text-sm font-semibold tracking-tight text-zinc-50">Mission Control</h1>
              <span className="text-xs text-zinc-500">
                {cards.length} session{cards.length === 1 ? "" : "s"} · {aliveCount} alive · scan{" "}
                {data?.ms ?? 0}ms
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-0.5 rounded border border-zinc-700 p-0.5">
                {WINDOW_OPTIONS.map((opt) => (
                  <button
                    key={opt.label}
                    type="button"
                    onClick={() => setWindowMs(opt.ms)}
                    aria-pressed={windowMs === opt.ms}
                    className={`rounded px-2 py-0.5 text-xs transition-colors ${
                      windowMs === opt.ms
                        ? "bg-zinc-700 text-zinc-100"
                        : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              {temporary.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowTemporary((v) => !v)}
                  className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 transition-colors hover:bg-zinc-900 hover:text-zinc-200"
                >
                  {showTemporary ? "hide" : "show"} {temporary.length} temporary session
                  {temporary.length === 1 ? "" : "s"}
                </button>
              )}
              <DispatchBar cards={cards} onDispatched={handleDispatched} />
            </div>
          </div>

          {!loading && visible.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
              {STATUS_ORDER.map((s) => (
                <span key={s} className="flex items-center gap-1">
                  <span className={`h-1.5 w-1.5 rounded-full ${STATUS_META[s].dot}`} aria-hidden="true" />
                  {counts[s]} {STATUS_META[s].label}
                </span>
              ))}
            </div>
          )}
        </header>

        {banner && (
          <div
            role="alert"
            className="mb-3 rounded border border-amber-700/60 bg-amber-950/40 px-3 py-2 text-xs text-amber-300"
          >
            {banner}
          </div>
        )}

        {drift && (
          <div
            role="alert"
            className="mb-3 rounded border border-sky-700/60 bg-sky-950/40 px-3 py-2 text-xs text-sky-300"
          >
            Schema drift detected — {drift}
          </div>
        )}

        {pendingSessions.length > 0 && (
          <section className="mb-3">
            <h2 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              starting…
            </h2>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
              {pendingSessions.map((p) => (
                <PendingCardView key={p.sessionId} pending={p} onSettled={handlePendingSettled} />
              ))}
            </div>
          </section>
        )}

        {loading ? (
          <p className="text-sm text-zinc-500">Loading fleet…</p>
        ) : groups.length === 0 ? (
          <p className="text-sm text-zinc-500">No sessions to show.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {groups.map((group) => (
              <section key={group.repoLabel}>
                <h2 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                  {group.repoLabel}
                </h2>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
                  {group.cards.map((card) => (
                    <FleetCardView key={card.sessionId} card={card} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FleetCardView({ card }: { card: FleetCard }) {
  const meta = STATUS_META[card.status];
  const headline = card.title || card.name;
  const lastPrompt = truncate(card.lastPrompt, 140);
  const lastDeliverable = truncate(card.lastDeliverable, 140);

  return (
    <div
      className={`flex flex-col gap-1 rounded-md border border-l-2 border-zinc-800 bg-zinc-900/60 px-2.5 py-2 ${meta.border}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          title={card.statusSignal}
          className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${meta.pill}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} aria-hidden="true" />
          {meta.label}
        </span>
        {!card.cwdExists && (
          <span className="shrink-0 rounded bg-amber-950/60 px-1 text-[10px] text-amber-500">
            dir missing
          </span>
        )}
      </div>

      <div className="truncate text-[13px] font-medium text-zinc-100" title={headline}>
        {headline}
      </div>

      <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-[11px] text-zinc-500">
        <span className="truncate">{card.repoLabel}</span>
        {card.worktreeName && (
          <span className="truncate text-zinc-600">· {card.worktreeName}</span>
        )}
      </div>

      {lastPrompt && (
        <div className="line-clamp-2 text-[11px] text-zinc-400" title={card.lastPrompt}>
          {lastPrompt}
        </div>
      )}
      {lastDeliverable && (
        <div className="line-clamp-2 text-[11px] text-zinc-500" title={card.lastDeliverable}>
          → {lastDeliverable}
        </div>
      )}

      <div className="mt-auto flex flex-wrap items-center gap-x-1.5 gap-y-1 pt-1 text-[10px] text-zinc-500">
        <span className="rounded bg-zinc-800 px-1.5 py-0.5">{card.kind}</span>
        <span>{relativeTime(card.lastActivityAt)}</span>
        {typeof card.pid === "number" && <span>pid {card.pid}</span>}
        {card.branch && <span className="rounded bg-zinc-800 px-1.5 py-0.5">{card.branch}</span>}
        {typeof card.prNumber === "number" &&
          (card.prUrl ? (
            <a
              href={card.prUrl}
              target="_blank"
              rel="noreferrer"
              className="text-sky-400 hover:underline"
            >
              PR #{card.prNumber}
            </a>
          ) : (
            <span>PR #{card.prNumber}</span>
          ))}
        {card.model && <span className="truncate">{card.model}</span>}
        <a
          href={`claude://resume?session=${encodeURIComponent(card.sessionId)}`}
          className="ml-auto shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100"
        >
          resume ↗
        </a>
      </div>

      <SessionConsole sessionId={card.sessionId} />
    </div>
  );
}

/** A session dispatched from the header bar, shown before the fleet scan has a real card for it. */
function PendingCardView({
  pending,
  onSettled,
}: {
  pending: PendingSession;
  onSettled: (sessionId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-l-2 border-zinc-800 border-l-sky-500 bg-zinc-900/60 px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="flex shrink-0 items-center gap-1 rounded bg-sky-950/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-sky-300">
          <span className="h-1.5 w-1.5 rounded-full bg-sky-400" aria-hidden="true" />
          starting
        </span>
      </div>

      <div className="truncate text-[13px] font-medium text-zinc-100" title={pending.repoLabel}>
        {pending.repoLabel}
      </div>

      <div className="line-clamp-2 text-[11px] text-zinc-400" title={pending.prompt}>
        {pending.prompt}
      </div>

      <SessionConsole
        sessionId={pending.sessionId}
        initialRun={{ response: pending.response }}
        onInitialRunSettled={() => onSettled(pending.sessionId)}
      />
    </div>
  );
}
