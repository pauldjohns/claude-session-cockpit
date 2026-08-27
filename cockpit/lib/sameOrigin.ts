/**
 * Loopback is not authentication.
 *
 * These routes run `claude` as a subprocess in a directory the caller names. Binding to
 * 127.0.0.1 stops the network reaching them; it does NOT stop a web page the user happens to
 * have open from POSTing to them, nor a DNS-rebinding attack from reading the fleet. Both are
 * cross-origin, so both are refused here.
 *
 * Accepts: same-origin requests (Sec-Fetch-Site: same-origin), and requests with no Origin at
 * all (curl, the test suite). Refuses anything whose Origin or Host is not loopback.
 */
const LOOPBACK = /^(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/;

export function isSameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;

  const host = request.headers.get("host") ?? "";
  if (!LOOPBACK.test(host)) return false;          // DNS rebinding: Host is the attacker's name

  const origin = request.headers.get("origin");
  if (!origin) return true;                         // no Origin: not a browser cross-site request
  try {
    return LOOPBACK.test(new URL(origin).host);
  } catch {
    return false;
  }
}

export function refuseCrossOrigin(): Response {
  return new Response(
    JSON.stringify({ ok: false, reason: "cross-origin", detail: "refused: not a same-origin request" }),
    { status: 403, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } },
  );
}
