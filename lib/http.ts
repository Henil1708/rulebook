// Request guards for a local-only app.
// - DNS rebinding: evil.example can resolve to 127.0.0.1, making the browser treat our API as same-origin
//   (Origin and Host both say evil.example). Only loopback Host names are served, so that never matches.
// - CSRF: a cross-site page can send a "simple" POST (text/plain, no preflight); requiring JSON forces a
//   CORS preflight we never approve, and a foreign Origin / Sec-Fetch-Site is refused.

const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

/** Hostnames we serve: loopback plus RULEBOOK_ALLOWED_HOSTS (comma-separated), e.g. for a hosted demo. */
function allowedHosts(): string[] {
  const extra = (process.env.RULEBOOK_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return [...LOOPBACK, ...extra];
}

function hostname(host: string): string | null {
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Every route, GET included: refuse requests whose Host isn't ours (DNS rebinding can read responses too). */
export function refuseForeignHost(req: Request): Response | null {
  const name = hostname(req.headers.get("host") ?? "");
  if (name === null || !allowedHosts().includes(name)) return Response.json({ error: "unexpected Host" }, { status: 403 });
  return null;
}

/** State-changing routes: foreign Host, non-JSON body, or another site's Origin are all refused. */
export function refuseCrossSite(req: Request): Response | null {
  const foreign = refuseForeignHost(req);
  if (foreign) return foreign;
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
