// GET /api/proposals — every stored proposal, newest first.
import { STORE_DIR } from "@/lib/paths";
import { proposalStore } from "@/lib/store/proposals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ proposals: proposalStore(STORE_DIR).list().reverse() });
}
