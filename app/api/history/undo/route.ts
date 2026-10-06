// POST /api/history/undo — body: { sha }. Reverts one rule change or dismissal with a new commit.
import { z } from "zod";
import { refuseCrossSite } from "@/lib/http";
import { undoChange } from "@/lib/review";
import { assertNotBusy, errorResponse, workspace } from "@/lib/workspace";

export const runtime = "nodejs";

const Body = z.object({ sha: z.string().regex(/^[0-9a-f]{7,40}$/) }).strict();

export async function POST(req: Request) {
  const refused = refuseCrossSite(req);
  if (refused) return refused;
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: "body must be { sha }" }, { status: 400 });
  try {
    assertNotBusy();
    return Response.json(await undoChange(workspace(), body.data.sha));
  } catch (err) {
    return errorResponse(err);
  }
}
