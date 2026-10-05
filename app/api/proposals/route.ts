// GET /api/proposals — every stored proposal, newest first.
import { refuseForeignHost } from "@/lib/http";
import { STORE_DIR } from "@/lib/paths";
import { proposalStore } from "@/lib/store/proposals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const refused = refuseForeignHost(req);
  if (refused) return refused;
  return Response.json({ proposals: proposalStore(STORE_DIR).list().reverse() });
}
