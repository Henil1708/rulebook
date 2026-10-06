// POST /api/preflight/rule — body: { form, rule_text, headline }. "Turn this into a rule": a suggestion that goes
// through the reviewer and waits for your approval like any other. Nothing is written to RULES.md here.
import { z } from "zod";
import { turnIntoRule } from "@/lib/agents/preflight";
import { refuseCrossSite } from "@/lib/http";
import { PreflightFormSchema } from "@/lib/preflight";
import { assertBudget, assertNotBusy, errorResponse } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ form: PreflightFormSchema, rule_text: z.string().min(10).max(300), headline: z.string().min(3).max(160) }).strict();

export async function POST(req: Request) {
  const refused = refuseCrossSite(req);
  if (refused) return refused;
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: "body must be { form, rule_text, headline }" }, { status: 400 });
  try {
    assertNotBusy();
    assertBudget();
    return Response.json(await turnIntoRule(body.data.form, body.data.rule_text, body.data.headline));
  } catch (err) {
    return errorResponse(err);
  }
}
