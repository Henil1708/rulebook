// runDrafter(target, ref): the root agent drafts one email following RULES.md *as it was at ref*.
// That version of the agent is checked out into a temp git worktree, so gitagent loads the old
// RULES.md into the system prompt exactly as it would have then. The worktree is removed afterwards.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEvidence } from "../evidence";
import { GitService, withLock } from "../git/GitService";
import { AGENT_DIR, STORE_DIR } from "../paths";
import { RULES_PATH } from "../review";
import { parseRules, type Rule } from "../rules";
import { runLog } from "../store/runs";
import { submitDraftTool, type DraftInput } from "../tools/draft";
import { readEvidenceTool } from "../tools/readEvidence";
import { runAgent, type OnEvent, type RunStatus } from "./run";

export const DRAFTER_TOOLS = ["read_evidence", "submit_draft"];
const MAX_TURNS = 4;

export interface Target {
  company: string;
  market?: string;
  company_stage?: string;
  segment?: string;
  inbox_type?: string;
  address_pattern?: string;
  /** Free text from the operator, e.g. the role or a detail about the company. */
  notes?: string;
}

export interface DraftResult {
  /** The commit the rulebook was taken from. */
  sha: string;
  /** The rules the Drafter followed, as they were at that commit. */
  rules: Rule[];
  draft?: DraftInput;
  status: RunStatus;
  error?: string;
  costUsd: number;
}

/** "v0" = the first commit (the July plan), "HEAD" = now, or a commit sha. */
async function resolveRef(git: GitService, ref: string): Promise<string> {
  if (ref === "v0") {
    const log = await git.log({ max: 10_000 });
    return log.at(-1)!.sha;
  }
  return (await git.log({ ref, max: 1 }))[0].sha;
}

export function runDrafter(target: Target, ref: string, opts: { signal?: AbortSignal; onEvent?: OnEvent } = {}): Promise<DraftResult> {
  return withLock(async () => {
    const git = new GitService(AGENT_DIR);
    const sha = await resolveRef(git, ref);
    const dir = join(mkdtempSync(join(tmpdir(), "rulebook-draft-")), "agent");
    await git.addWorktreeUnlocked(sha, dir);
    try {
      const rules = parseRules(readFileSync(join(dir, RULES_PATH), "utf8"));
      let draft: DraftInput | undefined;
      const rows = loadEvidence();
      const run = await runAgent({
        agent: "drafter",
        dir,
        prompt: [
          `Target: ${JSON.stringify(target)}`,
          "Follow your RULES.md exactly. If a rule says not to contact this target, or not this way, decide skip and say which rule.",
          "Otherwise draft one short email: pick the address or inbox the rules allow, a specific subject, and a body under 150 words.",
          'Cite the rule behind each choice inline, e.g. "(R-002)", and list every cited ID in cited_rules.',
          "You may use read_evidence (e.g. filter by company) to see past outreach to this target. Then call submit_draft exactly once.",
        ].join("\n"),
        tools: [readEvidenceTool(() => rows), submitDraftTool(rules.map((r) => r.id), (d) => (draft = d))],
        allowedTools: DRAFTER_TOOLS,
        maxTurns: MAX_TURNS,
        signal: opts.signal,
        onEvent: opts.onEvent,
      });
      const costUsd = run.costs.totalCostUsd;
      runLog(STORE_DIR).add({ kind: "drafter", status: run.status, costUsd, proposalIds: [] });
      return { sha, rules, ...(draft ? { draft } : {}), status: run.status, ...(run.error ? { error: run.error } : {}), costUsd };
    } finally {
      await git.removeWorktreeUnlocked(dir);
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  });
}
