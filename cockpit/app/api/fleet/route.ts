import { NextResponse } from "next/server";
import { getFleet } from "@/lib/fleet";
import { isSameOrigin, refuseCrossOrigin } from "@/lib/sameOrigin";

// This reads live process state on every request; never let Next cache a stale fleet.
export const dynamic = "force-dynamic";

/** Parses the board's window selector (?windowMs=). Any missing/invalid value falls back to getFleet()'s default. */
function parseWindowMs(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export async function GET(request: Request) {
  if (!isSameOrigin(request)) return refuseCrossOrigin();
  try {
    const windowMs = parseWindowMs(new URL(request.url).searchParams.get("windowMs"));
    const result = await getFleet({ windowMs });
    return NextResponse.json(result);
  } catch (err) {
    // getFleet() / readLiveSessions() are documented to never throw, but this catch is the
    // last line of defense: the board must get a 200 with an error field to render, never a
    // 500 that turns into a blank page or a Next error overlay.
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ cards: [], error: message, ms: 0, windowMs: 0, drift: undefined });
  }
}
