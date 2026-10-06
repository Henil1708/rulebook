// POST /api/preflight — body: PreflightForm plus an optional job_post (the pasted job description). "Should I send this?": a verdict from your rules and your history.
// The numbers are computed in code; the model only words the verdict (see lib/preflight.ts).
import { PreflightError, runPreflight } from "@/lib/agents/preflight";
import { GitService } from "@/lib/git/GitService";
import { refuseCrossSite } from "@/lib/http";
import { AGENT_DIR, STORE_DIR } from "@/lib/paths";
import { checkStore } from "@/lib/store/checks";
import { z } from "zod";
import { MAX_JOB_POST, PreflightFormSchema } from "@/lib/preflight";
import { assertBudget, assertNotBusy, errorResponse, isInitialised } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = PreflightFormSchema.extend({
  job_post: z.string().max(MAX_JOB_POST).optional(),
  role: z.string().max(80).optional(),
  company_name: z.string().max(80).optional(),
}).strict();

export async function POST(req: Request) {
  const refused = refuseCrossSite(req);
  if (refused) return refused;
  const form = Body.safeParse(await req.json().catch(() => null));
  if (!form.success) return Response.json({ error: "body must be { location, company, who, address, job_post? }" }, { status: 400 });
  if (!process.env.OPENAI_API_KEY) return Response.json({ error: "OPENAI_API_KEY is not set.", code: "missing_key" }, { status: 503 });
  if (!isInitialised()) return Response.json({ error: "The workspace isn't set up yet.", code: "not_initialised" }, { status: 409 });
  try {
    assertNotBusy();
    assertBudget();
    const { job_post, role, company_name, ...answers } = form.data;
    const jobPost = job_post?.trim() || undefined;
    const result = await runPreflight(answers, { signal: req.signal, jobPost });
    // Saved so the operator can reopen it from Recent; the rulebook commit tells later whether rules changed since.
    const rulesSha = await new GitService(AGENT_DIR).head().catch(() => undefined);
    const check = checkStore(STORE_DIR).add({ form: answers, verdict: result, ...(jobPost ? { jobPost } : {}), ...(role ? { role } : {}), ...(company_name ? { company: company_name } : {}), ...(rulesSha ? { rulesSha } : {}) });
    return Response.json({ ...result, checkId: check.id });
  } catch (err) {
    if (err instanceof PreflightError) return Response.json({ error: err.message, code: "inconsistent" }, { status: 502 });
    return errorResponse(err);
  }
}
