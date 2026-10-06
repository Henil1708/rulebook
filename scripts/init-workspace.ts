// npm run init:workspace — copy agent-template/ to workspace/agent and make it a git repo.
// Idempotent: an existing workspace repo is left untouched.
import { initWorkspace } from "../lib/workspace";

const r = await initWorkspace();
console.log(r.created ? `workspace initialised: ${r.dir} @ ${r.sha!.slice(0, 7)}` : `workspace already initialised: ${r.dir}`);
