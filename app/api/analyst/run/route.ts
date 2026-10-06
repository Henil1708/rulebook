// POST /api/analyst/run — runs the Analyst and streams its events as server-sent events.
// Body: { synthetic?: boolean, from?: "YYYY-MM-DD", to?: "YYYY-MM-DD" } — no dates = every result (what the UI sends).
// Events: one per gitagent message (event = message type, data.agent = "analyst" | "skeptic"; the Skeptic
// runs on each new proposal after the Analyst), then `done` (AnalystResult) or `error`.
import { z } from "zod";
import { refuseCrossSite } from "@/lib/http";
import { runAnalyst } from "@/lib/agents/analyst";
import { assertBudget, assertNotBusy, errorResponse, isInitialised } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Body = z.object({ from: DATE.optional(), to: DATE.optional(), synthetic: z.boolean().optional() }).strict().refine((b) => !b.from === !b.to);

export async function POST(req: Request) {
  const refused = refuseCrossSite(req);
  if (refused) return refused;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "body must be { synthetic?: boolean, from?: YYYY-MM-DD, to?: YYYY-MM-DD } (both dates or neither)" }, { status: 400 });
  }
  if (!process.env.OPENAI_API_KEY) {
    return Response.json({ error: "OPENAI_API_KEY is not set. Add it to .env.local and restart the server.", code: "missing_key" }, { status: 503 });
  }
  if (!isInitialised()) return Response.json({ error: "The workspace isn't set up yet.", code: "not_initialised" }, { status: 409 });
  try {
    assertNotBusy();
    assertBudget();
  } catch (err) {
    return errorResponse(err);
  }
  const { from, to, synthetic } = parsed.data;

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // The browser may go away mid-run; writing to a closed stream must not break the agents.
      let open = true;
      const send = (event: string, data: unknown) => {
        if (!open) return;
        try {
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          open = false;
        }
      };
      try {
        const result = await runAnalyst({ ...(from && to ? { window: { from, to } } : {}), synthetic, signal: req.signal, onEvent: (m, agent) => send(m.type, { ...m, agent }) });
        send("done", result);
      } catch (err) {
        send("error", { message: (err as Error).message });
      } finally {
        if (open) controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
