// POST /api/proposals/combine — body: { ids: string[] } (2+ suggestions for the same rule).
// The AI drafts one wording and the Skeptic reviews it; returns the draft suggestion to apply with /accept.
import { z } from "zod";
import { combineProposals } from "@/lib/agents/combine";
import { refuseCrossSite } from "@/lib/http";
import { assertBudget, assertNotBusy, errorResponse } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ ids: z.array(z.string().regex(/^P-\d+$/)).min(2).max(10) }).strict();

export async function POST(req: Request) {
  const refused = refuseCrossSite(req);
  if (refused) return refused;
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: "body must be { ids: string[] } with at least 2 IDs" }, { status: 400 });
  if (!process.env.OPENAI_API_KEY) return Response.json({ error: "OPENAI_API_KEY is not set.", code: "missing_key" }, { status: 503 });
  try {
    assertNotBusy();
    assertBudget();
    return Response.json(await combineProposals(body.data.ids, { signal: req.signal }));
  } catch (err) {
    return errorResponse(err);
  }
}
