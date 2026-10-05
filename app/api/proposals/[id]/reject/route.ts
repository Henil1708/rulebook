// POST /api/proposals/:id/reject — body: { reason: string } (required).
// Records the reason in the Analyst's memory and commits memory(analyst): rejected P-### — reason.
import { z } from "zod";
import { refuseCrossSite } from "@/lib/http";
import { rejectProposal } from "@/lib/review";
import { errorResponse, workspace } from "@/lib/workspace";

export const runtime = "nodejs";

const Body = z.object({ reason: z.string().min(1).max(500) }).strict();

export async function POST(req: Request, ctx: RouteContext<"/api/proposals/[id]/reject">) {
  const refused = refuseCrossSite(req);
  if (refused) return refused;
  const { id } = await ctx.params;
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: "body must be { reason: string }" }, { status: 400 });
  try {
    return Response.json(await rejectProposal(workspace(), id, body.data.reason));
  } catch (err) {
    return errorResponse(err);
  }
}
