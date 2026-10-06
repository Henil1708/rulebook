// GET /api/checks — your saved checks, newest first (for the Recent list).
import { refuseForeignHost } from "@/lib/http";
import { STORE_DIR } from "@/lib/paths";
import { checkStore } from "@/lib/store/checks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const refused = refuseForeignHost(req);
  if (refused) return refused;
  return Response.json({ checks: checkStore(STORE_DIR).summaries() });
}
