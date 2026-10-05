// CSRF guard for state-changing routes. A cross-site page can send a "simple" POST (text/plain, no
// preflight) to localhost; requiring JSON forces a CORS preflight we never approve, and the Origin
// check refuses anything that does arrive from another site.
export function refuseCrossSite(req: Request): Response | null {
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const origin = req.headers.get("origin");
  if (origin !== null) {
    let host: string | null = null;
    try {
      host = new URL(origin).host;
    } catch {
      // "null" or malformed origin: refuse below
    }
    if (host !== req.headers.get("host")) return Response.json({ error: "cross-origin request refused" }, { status: 403 });
  }
  if (req.headers.get("sec-fetch-site") === "cross-site") return Response.json({ error: "cross-origin request refused" }, { status: 403 });
  return null;
}
