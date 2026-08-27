/**
 * POST /api/sessions/<sessionId>/continue
 *
 * Body: `{ "message": string, "model"?: string }`
 *
 * Success → 200, `application/x-ndjson`, the run's `stream-json` output as it arrives, plus a
 * final `cockpit_status` line. `x-cockpit-*` headers carry the run's identity before the first
 * byte of model output, so the UI can render a card immediately.
 *
 * Guard refusal → **409** with `{ ok:false, reason, jumpUrl, pid }`. 409 Conflict is the honest
 * code: the session is in a state that conflicts with writing to it, and the client is expected
 * to send the user to `jumpUrl` instead of retrying.
 *
 * Nothing here can produce an unhandled 500. Every path returns a structured JSON body,
 * including the catch-all.
 */

import { continueSession, type ContinueRefusalReason } from "@/lib/dispatch";
import { isSameOrigin, refuseCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Refusals that mean "the session is in a conflicting state", i.e. the guard fired. */
const GUARD_REASONS: ReadonlySet<ContinueRefusalReason> = new Set([
  "alive",
  "unresolvable",
  "missing-transcript",
  "missing-cwd",
  "transcript-changed",
  "busy",
]);

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!isSameOrigin(request)) return refuseCrossOrigin();
  let sessionId = "";
  try {
    sessionId = (await ctx.params).id;

    let body: unknown = null;
    try {
      body = await request.json();
    } catch {
      return json(
        { ok: false, sessionId, reason: "bad-request", detail: "body is not JSON" },
        400,
      );
    }
    const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

    const result = await continueSession({
      sessionId,
      message: typeof b.message === "string" ? b.message : "",
      model: typeof b.model === "string" ? b.model : undefined,
    });

    if (!result.ok) {
      const status = GUARD_REASONS.has(result.reason) ? 409 : 400;
      return json(
        {
          ok: false,
          sessionId: result.sessionId,
          reason: result.reason,
          detail: result.detail,
          pid: result.pid,
          jumpUrl: result.jumpUrl,
        },
        status,
      );
    }

    return new Response(result.stream, {
      status: 200,
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
        // Streaming through a proxy that buffers would defeat the point of streaming at all.
        "x-accel-buffering": "no",
        "x-cockpit-session-id": result.sessionId,
        "x-cockpit-pid": String(result.pid),
        "x-cockpit-bytes": String(result.bytes),
      },
    });
  } catch (err) {
    // continueSession() is written not to throw. This is the last line of defence: a structured
    // body the board can render, never a Next error overlay.
    return json(
      {
        ok: false,
        sessionId,
        reason: "internal",
        detail: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
}
