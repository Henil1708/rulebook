// GET /api/evidence?from=YYYY-MM-DD&to=YYYY-MM-DD&synthetic=1 — rows for the Evidence feed plus window stats.
// GET /api/evidence?proposal=P-005 — the emails behind one suggestion (its slice; a combined one's union).
// Recipients and subjects stay server-side; the feed shows attributes and outcomes.
import { refuseForeignHost } from "@/lib/http";
import { filterEvidence, isSend, loadEvidence, sliceStats, stats, toFeedRow, WindowSchema } from "@/lib/evidence";
import { STORE_DIR } from "@/lib/paths";
import { proposalRows } from "@/lib/review";
import { proposalStore } from "@/lib/store/proposals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const refused = refuseForeignHost(req);
  if (refused) return refused;
  const q = new URL(req.url).searchParams;
  const window = WindowSchema.safeParse({ ...(q.get("from") ? { from: q.get("from") } : {}), ...(q.get("to") ? { to: q.get("to") } : {}) });
  if (!window.success) return Response.json({ error: "from/to must be YYYY-MM-DD" }, { status: 400 });

  const id = q.get("proposal");
  if (id) {
    const store = proposalStore(STORE_DIR);
    const p = store.get(id);
    if (!p) return Response.json({ error: `${id} not found` }, { status: 404 });
    const all = loadEvidence({ synthetic: p.synthetic });
    const rows = proposalRows(all, p, store.get).filter(isSend).sort(newestFirst);
    return Response.json({ rows: rows.map(toFeedRow), stats: stats(rows), total: all.length });
  }

  const all = loadEvidence({ synthetic: q.get("synthetic") === "1" });
  const rows = filterEvidence(all, {}, window.data)
    .sort(newestFirst)
    .map(toFeedRow);
  return Response.json({ rows, stats: sliceStats(all, {}, window.data), total: all.length });
}

const newestFirst = (a: { sent_at: string | null; id: string }, b: { sent_at: string | null; id: string }) =>
  (b.sent_at ?? "").localeCompare(a.sent_at ?? "") || b.id.localeCompare(a.id);
