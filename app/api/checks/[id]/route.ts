// GET /api/checks/:id — one saved check with its answers, job post, verdict and every email version.
import { refuseForeignHost } from "@/lib/http";
import { STORE_DIR } from "@/lib/paths";
import { checkStore } from "@/lib/store/checks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: RouteContext<"/api/checks/[id]">) {
  const refused = refuseForeignHost(req);
  if (refused) return refused;
  const { id } = await ctx.params;
  const check = checkStore(STORE_DIR).get(id);
  return check ? Response.json(check) : Response.json({ error: `${id} not found` }, { status: 404 });
}
