// runSkeptic: one Skeptic query() per proposal. It sees the same evidence as the Analyst that made it.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { filterEvidence, loadEvidence, sliceStats } from "../evidence";
import { withLock } from "../git/GitService";
import { AGENT_DIR, STORE_DIR } from "../paths";
import { proposalRows, renderSlice } from "../review";
import { proposalStore, type Critique } from "../store/proposals";
import { runLog } from "../store/runs";
import { MIN_N_FOR_SUPPORT, submitCritiqueTool } from "../tools/critique";
import { readEvidenceTool } from "../tools/readEvidence";
import { runAgent, type AgentRunResult, type OnEvent } from "./run";

export const SKEPTIC_TOOLS = ["read_evidence", "submit_critique"];
const MAX_TURNS = 4;
const MAX_TURNS_COMBINED = 6; // a combined suggestion spans several groups of emails: more to read

export interface SkepticResult extends AgentRunResult {
  proposalId: string;
  runId: string;
  critique?: Critique;
}

/** Caller must hold the workspace lock (runAnalyst does; runSkeptic takes it). */
export async function skepticUnlocked(proposalId: string, opts: { signal?: AbortSignal; onEvent?: OnEvent } = {}): Promise<SkepticResult> {
  const store = proposalStore(STORE_DIR);
  const p = store.get(proposalId);
  if (!p) throw new Error(`${proposalId} not found`);
  const runId = randomUUID();
  const all = loadEvidence({ synthetic: p.synthetic });
  // A combined suggestion has no single slice: the Skeptic reads exactly the union of its parts' emails.
  const members = p.combines?.map((id) => store.get(id)).filter((m) => m !== undefined) ?? [];
  const rows = p.combines ? proposalRows(all, p, store.get) : filterEvidence(all, {}, p.window ?? {});
  const base = sliceStats(p.combines ? all : rows);

  const proposal = {
    id: p.id,
    change: `${p.op}${p.rule_id ? ` ${p.rule_id}` : ""}`,
    rule_text: p.rule_text ?? "(retire: no new text)",
    slice: p.combines ? `union of: ${members.map((m) => renderSlice(m.slice)).join(" OR ")} (read_evidence with no filter returns exactly these rows)` : renderSlice(p.slice),
    slice_filter: p.combines ? {} : p.slice,
    checked_by_server: p.check,
    analyst_claim: { n: p.n, metric: p.metric, confidence: p.confidence },
    evidence_ids: p.evidence_ids,
    rationale: p.rationale,
  };
  const prompt = [
    `Review this proposed rule change. Evidence: ${p.window ? `${p.window.from} to ${p.window.to}` : `all results, sent ${span(rows)}`}${p.synthetic ? " (includes synthetic rows)" : ""}. read_evidence already covers exactly this; do not pass a window.`,
    ...(p.combines ? [`It combines ${p.combines.length} earlier suggestions into one wording. Judge the combined wording against the combined emails.`] : []),
    `Baseline over that window: n=${base.n}, ${base.humanReplies} human replies (rate ${base.rate.toFixed(3)}), ${base.bounces} bounces.`,
    `Proposal: ${JSON.stringify(proposal)}`,
    "Check: does the slice's outcome really support the change, in the direction claimed? Sample size, confounders (same company, the 12 Jul mass send, market vs inbox type, duplicates), rejections counted as replies, synthetic rows.",
    `Use read_evidence with the slice filter or nearby slices if you need to. A slice with fewer than ${MIN_N_FOR_SUPPORT} sends can never get "support".`,
    `Then call submit_critique exactly once, within ${p.combines ? MAX_TURNS_COMBINED : MAX_TURNS} steps in total.`,
  ].join("\n");

  let result: AgentRunResult;
  try {
    result = await runAgent({
      agent: "skeptic",
      dir: join(AGENT_DIR, "agents", "skeptic"),
      prompt,
      tools: [readEvidenceTool(() => rows), submitCritiqueTool({ proposalId, runId, store })],
      allowedTools: SKEPTIC_TOOLS,
      maxTurns: p.combines ? MAX_TURNS_COMBINED : MAX_TURNS,
      signal: opts.signal,
      onEvent: opts.onEvent,
    });
  } catch (err) {
    store.update(proposalId, { critique_error: (err as Error).message });
    throw err;
  }

  const critique = store.get(proposalId)?.critique;
  if (critique?.run_id !== runId) {
    store.update(proposalId, { critique_error: `Skeptic did not submit a critique (${result.status}${result.error ? `: ${result.error}` : ""})` });
    return { proposalId, runId, ...result };
  }
  return { proposalId, runId, ...result, critique };
}

export function runSkeptic(proposalId: string, opts: { signal?: AbortSignal; onEvent?: OnEvent } = {}): Promise<SkepticResult> {
  return withLock(async () => {
    const r = await skepticUnlocked(proposalId, opts);
    runLog(STORE_DIR).add({ kind: "skeptic", status: r.status, costUsd: r.costs.totalCostUsd, proposalIds: [proposalId] });
    return r;
  });
}

/** "2026-07-12 to 2026-10-05": the dates the rows were sent, so the model never has to guess a window. */
function span(rows: { sent_at: string | null }[]): string {
  const days = rows.map((r) => r.sent_at?.slice(0, 10)).filter((d): d is string => Boolean(d)).sort();
  return days.length ? `${days[0]} to ${days.at(-1)}` : "no dates";
}
