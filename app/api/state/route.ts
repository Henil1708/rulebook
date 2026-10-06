// GET /api/state — what the workbench renders: workspace status, branch, rules with their origin commits.
import { refuseForeignHost } from "@/lib/http";
import { workspaceState } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const refused = refuseForeignHost(req);
  if (refused) return refused;
  return Response.json(await workspaceState());
}
