// runSkeptic: one Skeptic query() per proposal. It sees the same evidence as the Analyst that made it.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { filterEvidence, loadEvidence, sliceStats } from "../evidence";
import { withLock } from "../git/GitService";
import { AGENT_DIR, STORE_DIR } from "../paths";
import { renderSlice } from "../review";
import { proposalStore, type Critique } from "../store/proposals";
import { MIN_N_FOR_SUPPORT, submitCritiqueTool } from "../tools/critique";
import { readEvidenceTool } from "../tools/readEvidence";
import { runAgent, type AgentRunResult, type OnEvent } from "./run";

export const SKEPTIC_TOOLS = ["read_evidence", "submit_critique"];
const MAX_TURNS = 4;

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
  const rows = filterEvidence(loadEvidence({ synthetic: p.synthetic }), {}, p.window ?? {});
  const base = sliceStats(rows);

  const proposal = {
    id: p.id,
    change: `${p.op}${p.rule_id ? ` ${p.rule_id}` : ""}`,
    rule_text: p.rule_text ?? "(retire: no new text)",
    slice: renderSlice(p.slice),
    slice_filter: p.slice,
    checked_by_server: p.check,
    analyst_claim: { n: p.n, metric: p.metric, confidence: p.confidence },
    evidence_ids: p.evidence_ids,
    rationale: p.rationale,
  };
  const prompt = [
    `Review this proposed rule change. Evidence window: ${p.window ? `${p.window.from} to ${p.window.to}` : "all real evidence"}${p.synthetic ? " (includes synthetic rows)" : ""}.`,
    `Baseline over that window: n=${base.n}, ${base.humanReplies} human replies (rate ${base.rate.toFixed(3)}), ${base.bounces} bounces.`,
    `Proposal: ${JSON.stringify(proposal)}`,
    "Check: does the slice's outcome really support the change, in the direction claimed? Sample size, confounders (same company, the 12 Jul mass send, market vs inbox type, duplicates), rejections counted as replies, synthetic rows.",
    `Use read_evidence with the slice filter or nearby slices if you need to. A slice with fewer than ${MIN_N_FOR_SUPPORT} sends can never get "support".`,
    "Then call submit_critique exactly once.",
  ].join("\n");

  let result: AgentRunResult;
  try {
    result = await runAgent({
      agent: "skeptic",
      dir: join(AGENT_DIR, "agents", "skeptic"),
      prompt,
      tools: [readEvidenceTool(() => rows), submitCritiqueTool({ proposalId, runId, store })],
      allowedTools: SKEPTIC_TOOLS,
      maxTurns: MAX_TURNS,
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
  return withLock(() => skepticUnlocked(proposalId, opts));
}
