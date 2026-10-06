// POST /api/preflight/email — body: { form, verdict: { verdict, rule_ids, do_instead }, job_post? }.
// Writes the email to send, from your rules, the verdict, the job post and your past emails that got replies.
// Nothing is sent: the operator copies it.
import { z } from "zod";
import { draftEmail, PreflightError } from "@/lib/agents/preflight";
import { refuseCrossSite } from "@/lib/http";
import { STORE_DIR } from "@/lib/paths";
import { checkStore } from "@/lib/store/checks";
import { MAX_JOB_POST, PreflightFormSchema } from "@/lib/preflight";
import { assertBudget, assertNotBusy, errorResponse } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z
  .object({
    form: PreflightFormSchema,
    verdict: z.object({ verdict: z.enum(["go", "change", "skip", "no_rule"]), rule_ids: z.array(z.string().max(10)).max(6), do_instead: z.string().max(240).nullable() }).strict(),
    job_post: z.string().max(MAX_JOB_POST).optional(),
    check_id: z.string().regex(/^C-\d+$/).optional(),
  })
  .strict();

export async function POST(req: Request) {
  const refused = refuseCrossSite(req);
  if (refused) return refused;
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: "body must be { form, verdict, job_post? }" }, { status: 400 });
  if (!process.env.OPENAI_API_KEY) return Response.json({ error: "OPENAI_API_KEY is not set.", code: "missing_key" }, { status: 503 });
  try {
    assertNotBusy();
    assertBudget();
    const { form, verdict, job_post, check_id } = body.data;
    const email = await draftEmail(form, verdict, { signal: req.signal, jobPost: job_post?.trim() || undefined });
    const store = checkStore(STORE_DIR);
    if (check_id && store.get(check_id)) store.addEmail(check_id, email); // kept as a version of that check
    return Response.json(email);
  } catch (err) {
    if (err instanceof PreflightError) return Response.json({ error: err.message }, { status: 502 });
    return errorResponse(err);
  }
}
