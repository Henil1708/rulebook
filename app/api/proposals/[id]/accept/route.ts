// POST /api/proposals/:id/accept — body: { text?: string } (the operator's edited rule text).
// Applies the proposal to RULES.md and commits rule(R-###) with trailers.
import { z } from "zod";
import { acceptProposal } from "@/lib/review";
import { errorResponse, workspace } from "@/lib/workspace";

export const runtime = "nodejs";

const Body = z.object({ text: z.string().max(300).optional() }).strict();

export async function POST(req: Request, ctx: RouteContext<"/api/proposals/[id]/accept">) {
  const { id } = await ctx.params;
  const body = Body.safeParse((await req.json().catch(() => ({}))) ?? {});
  if (!body.success) return Response.json({ error: "body must be { text?: string }" }, { status: 400 });
  try {
    return Response.json(await acceptProposal(workspace(), id, body.data.text));
  } catch (err) {
    return errorResponse(err);
  }
}
