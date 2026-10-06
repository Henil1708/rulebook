// POST /api/preflight/read — body: { job_post }. Reads a pasted job description into the pre-flight answers
// it makes clear (the rest stay null). The operator confirms them before running the check.
import { z } from "zod";
import { PreflightError, readJobPost } from "@/lib/agents/preflight";
import { refuseCrossSite } from "@/lib/http";
import { MAX_JOB_POST } from "@/lib/preflight";
import { assertBudget, assertNotBusy, errorResponse } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ job_post: z.string().min(40).max(MAX_JOB_POST) }).strict();

export async function POST(req: Request) {
  const refused = refuseCrossSite(req);
  if (refused) return refused;
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: `Paste the job post (40 to ${MAX_JOB_POST} characters).` }, { status: 400 });
  if (!process.env.OPENAI_API_KEY) return Response.json({ error: "OPENAI_API_KEY is not set.", code: "missing_key" }, { status: 503 });
  try {
    assertNotBusy();
    assertBudget();
    return Response.json(await readJobPost(body.data.job_post, { signal: req.signal }));
  } catch (err) {
    if (err instanceof PreflightError) return Response.json({ error: err.message }, { status: 502 });
    return errorResponse(err);
  }
}
