// POST /api/analyst/run — runs the Analyst and streams its events as server-sent events.
// Body: { from: "YYYY-MM-DD", to: "YYYY-MM-DD", synthetic?: boolean }
// Events: one per gitagent message (event = message type), then `done` (AnalystResult) or `error`.
import { z } from "zod";
import { refuseCrossSite } from "@/lib/http";
import { runAnalyst } from "@/lib/agents/analyst";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Body = z.object({ from: DATE, to: DATE, synthetic: z.boolean().optional() }).strict();

export async function POST(req: Request) {
  const refused = refuseCrossSite(req);
  if (refused) return refused;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "body must be { from: YYYY-MM-DD, to: YYYY-MM-DD, synthetic?: boolean }" }, { status: 400 });
  }
  if (!process.env.OPENAI_API_KEY) return Response.json({ error: "OPENAI_API_KEY is not set" }, { status: 503 });
  const { from, to, synthetic } = parsed.data;

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      try {
        const result = await runAnalyst({ window: { from, to }, synthetic, signal: req.signal, onEvent: (m) => send(m.type, m) });
        send("done", result);
      } catch (err) {
        send("error", { message: (err as Error).message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
