// POST /api/drafter — body: { target: {company, ...}, ref: "v0" | "HEAD" | <sha> }.
// Drafts one email following RULES.md as it was at `ref` (see runDrafter). Never sends anything.
import { z } from "zod";
import { runDrafter } from "@/lib/agents/drafter";
import { refuseCrossSite } from "@/lib/http";
import { assertBudget, assertNotBusy, errorResponse, isInitialised } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const field = z.string().max(60).optional();
const Body = z
  .object({
    target: z.object({ company: z.string().min(1).max(80), market: field, company_stage: field, segment: field, inbox_type: field, address_pattern: field, notes: z.string().max(300).optional() }).strict(),
    ref: z.string().regex(/^(v0|HEAD|[0-9a-f]{7,40})$/),
  })
  .strict();

export async function POST(req: Request) {
  const refused = refuseCrossSite(req);
  if (refused) return refused;
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: "body must be { target: { company, ... }, ref: v0 | HEAD | sha }" }, { status: 400 });
  if (!process.env.OPENAI_API_KEY) return Response.json({ error: "OPENAI_API_KEY is not set.", code: "missing_key" }, { status: 503 });
  if (!isInitialised()) return Response.json({ error: "The workspace isn't set up yet.", code: "not_initialised" }, { status: 409 });
  try {
    assertNotBusy();
    assertBudget();
    return Response.json(await runDrafter(body.data.target, body.data.ref, { signal: req.signal }));
  } catch (err) {
    return errorResponse(err);
  }
}
