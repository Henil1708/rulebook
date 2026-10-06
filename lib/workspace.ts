// The real workspace for route handlers and scripts: dependencies, init, and the state the UI renders.
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isSend, loadEvidence, stats, type SliceStats } from "./evidence";
import { GitService, lockBusy } from "./git/GitService";
import { toHistory, type HistoryItem } from "./history";
import { AGENT_DIR, STORE_DIR, WORKSPACE } from "./paths";
import { ReviewError, RULES_PATH } from "./review";
import { parseRules } from "./rules";
import { proposalStore } from "./store/proposals";
import { runLog, type Spend } from "./store/runs";

export const INIT_MESSAGE = "init: rulebook v0 (July 2026 strategy)";

export const workspace = () => ({ git: new GitService(AGENT_DIR), store: proposalStore(STORE_DIR) });

export const isInitialised = () => existsSync(join(AGENT_DIR, ".git"));

/** Copy agent-template/ to workspace/agent and make it a git repo. Idempotent: an existing repo is left alone. */
export async function initWorkspace(): Promise<{ created: boolean; dir: string; sha?: string }> {
  if (isInitialised()) return { created: false, dir: AGENT_DIR };
  rmSync(AGENT_DIR, { recursive: true, force: true }); // a half-copied dir from an interrupted run
  cpSync(join(process.cwd(), "agent-template"), AGENT_DIR, { recursive: true });
  const sha = await new GitService(AGENT_DIR).init(INIT_MESSAGE);
  return { created: true, dir: AGENT_DIR, sha };
}

export interface RuleOrigin {
  sha: string;
  date: string;
  subject: string;
  /** The v0 strategy commit: no evidence behind it. */
  initial: boolean;
  n?: number;
  evidence?: string[];
  critique?: string;
  approvedBy?: string;
  /** Applied on an early sign (an interested reply in a small group): a rule being tried out. */
  trial?: boolean;
  /** The evidence rows the change cites, as the UI shows them. */
  emails?: { id: string; company: string; outcome: string }[];
}

export interface RuleView {
  id: string;
  text: string;
  origin?: RuleOrigin;
}

export interface WorkspaceState {
  initialised: boolean;
  workspace: string;
  branch?: string;
  head?: { sha: string; subject: string; date: string };
  busy: boolean;
  hasKey: boolean;
  model: string;
  /** Every run's cost, saved in workspace/.rulebook/runs.json, so it survives refreshes and restarts. */
  spend: Spend;
  /** Every real result, so a suggestion's reply rate can be compared with the overall one. */
  baseline: SliceStats;
  rules: RuleView[];
  history: HistoryItem[];
}

/** Rules from RULES.md, each tied (via git blame) to the commit that last wrote its line. */
export async function workspaceState(): Promise<WorkspaceState> {
  const base = {
    workspace: WORKSPACE,
    busy: lockBusy(),
    hasKey: Boolean(process.env.OPENAI_API_KEY),
    model: process.env.RULEBOOK_MODEL || "openai:gpt-4o-mini",
    spend: runLog(STORE_DIR).spend(),
    baseline: stats(loadEvidence().filter(isSend)),
  };
  if (!isInitialised()) return { ...base, initialised: false, rules: [], history: [] };

  const git = new GitService(AGENT_DIR);
  const [branches, log, blame] = await Promise.all([git.branches(), git.log({ max: 500 }), git.blame(RULES_PATH)]);
  const commits = new Map(log.map((c) => [c.sha, c]));
  const shaByLine = new Map(blame.map((l) => [l.text.trim(), l.sha]));
  const initSha = log.at(-1)?.sha;

  const rowsById = new Map(loadEvidence({ synthetic: true }).map((e) => [e.id, e]));
  const rules = parseRules(readFileSync(join(AGENT_DIR, RULES_PATH), "utf8")).map((r): RuleView => {
    const c = commits.get(shaByLine.get(`- [${r.id}] ${r.text}`) ?? "");
    if (!c) return r;
    const t = c.trailers;
    return {
      ...r,
      origin: {
        sha: c.sha,
        date: c.date,
        subject: c.subject,
        initial: c.sha === initSha,
        ...(t.N ? { n: Number(t.N) } : {}),
        ...(t.Evidence ? { evidence: t.Evidence.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
        ...(t.Evidence
          ? { emails: t.Evidence.split(",").map((s) => rowsById.get(s.trim())).filter((e) => e !== undefined).map((e) => ({ id: e.id, company: e.company, outcome: e.outcome })) }
          : {}),
        ...(t.Critique ? { critique: t.Critique } : {}),
        ...(t["Approved-By"] ? { approvedBy: t["Approved-By"] } : {}),
        ...(t["Evidence-Level"]?.startsWith("early") ? { trial: true } : {}),
      },
    };
  });

  const head = log[0];
  return { ...base, initialised: true, branch: branches.current, head: head && { sha: head.sha, subject: head.subject, date: head.date }, rules, history: toHistory(log) };
}

/** Before a write: refuse with 409 while an agent run or another write holds the workspace. */
export function assertNotBusy(): void {
  if (lockBusy()) throw new ReviewError("The workspace is busy with another run or decision. Try again when it finishes.", 409, "busy");
}

/** Before an AI run: refuse once the saved spend reaches the budget. */
export function assertBudget(): void {
  const { totalCostUsd, budgetUsd } = runLog(STORE_DIR).spend();
  if (totalCostUsd >= budgetUsd) {
    throw new ReviewError(`You've used $${totalCostUsd.toFixed(2)} of your $${budgetUsd.toFixed(2)} AI budget. Raise RULEBOOK_BUDGET_USD to run again.`, 402, "budget");
  }
}

/** ReviewError → its status (and code); anything else → 500 with the message. */
export function errorResponse(err: unknown) {
  if (err instanceof ReviewError) return Response.json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, { status: err.status });
  return Response.json({ error: (err as Error).message }, { status: 500 });
}
