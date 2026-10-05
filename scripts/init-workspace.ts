// npm run init:workspace — copy agent-template/ to workspace/agent and make it a git repo.
// Idempotent: an existing workspace repo is left untouched.
import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { GitService } from "../lib/git/GitService";

const agentDir = join(process.cwd(), "workspace", "agent");

if (existsSync(join(agentDir, ".git"))) {
  console.log(`workspace already initialised: ${agentDir}`);
} else {
  rmSync(agentDir, { recursive: true, force: true }); // a half-copied dir from an interrupted run
  cpSync(join(process.cwd(), "agent-template"), agentDir, { recursive: true });
  const sha = await new GitService(agentDir).init("init: rulebook v0 (July 2026 strategy)");
  console.log(`workspace initialised: ${agentDir} @ ${sha.slice(0, 7)}`);
}
