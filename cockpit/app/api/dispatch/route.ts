/**
 * POST /api/dispatch
 *
 * Body: `{ "cwd": string, "prompt": string, "model"?: string }`
 *
 * Starts a *new* session. There is no conversation to fork, so there is no guard here — the
 * uuid is minted locally and returned in the `x-cockpit-session-id` header before the model has
 * produced anything, which is what lets the board show a card the moment the button is pressed.
 *
 * Refusals return **200** with `{ ok:false, reason, detail }`, per the console contract: a
 * refusal is a result the UI renders, not a transport failure. Only an unexpected throw becomes
 * a 5xx, and even that carries a structured body.
 */

import { dispatchNew } from "@/lib/dispatch";
import { isSameOrigin, refuseCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return refuseCrossOrigin();
  try {
    let body: unknown = null;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, reason: "bad-request", detail: "body is not JSON" }, 200);
    }
    const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

    const result = dispatchNew({
      cwd: typeof b.cwd === "string" ? b.cwd : "",
      prompt: typeof b.prompt === "string" ? b.prompt : "",
      model: typeof b.model === "string" ? b.model : undefined,
    });

    if (!result.ok) {
      return json(
        { ok: false, reason: result.reason, detail: result.detail, sessionId: result.sessionId },
        200,
      );
    }

    return new Response(result.stream, {
      status: 200,
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
        "x-cockpit-session-id": result.sessionId,
        "x-cockpit-pid": String(result.pid),
        "x-cockpit-cwd": encodeURIComponent(result.cwd),
      },
    });
  } catch (err) {
    return json(
      {
        ok: false,
        reason: "internal",
        detail: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
}
