// POST /api/proposals/dismiss — body: { ids: string[], reason: string }. One memory commit for all of them.
import { z } from "zod";
import { refuseCrossSite } from "@/lib/http";
import { rejectProposals } from "@/lib/review";
import { assertNotBusy, errorResponse, workspace } from "@/lib/workspace";

export const runtime = "nodejs";

const Body = z.object({ ids: z.array(z.string().regex(/^P-\d+$/)).min(1).max(20), reason: z.string().max(500) }).strict();

export async function POST(req: Request) {
  const refused = refuseCrossSite(req);
  if (refused) return refused;
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: "body must be { ids: string[], reason: string }" }, { status: 400 });
  try {
    assertNotBusy();
    return Response.json(await rejectProposals(workspace(), body.data.ids, body.data.reason));
  } catch (err) {
    return errorResponse(err);
  }
}
