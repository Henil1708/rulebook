// The real workspace dependencies for route handlers.
import { GitService } from "./git/GitService";
import { AGENT_DIR, STORE_DIR } from "./paths";
import { ReviewError } from "./review";
import { proposalStore } from "./store/proposals";

export const workspace = () => ({ git: new GitService(AGENT_DIR), store: proposalStore(STORE_DIR) });

/** ReviewError → its status; anything else → 500 with the message. */
export function errorResponse(err: unknown) {
  const status = err instanceof ReviewError ? err.status : 500;
  return Response.json({ error: (err as Error).message }, { status });
}
