// runAnalyst: one Analyst query() over the evidence (all of it unless a window is given), then the Skeptic on each new proposal,
// one at a time, all under one hold of the workspace lock.
import type { SessionCosts } from "@open-gitagent/gitagent";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { filterEvidence, loadEvidence, type Window } from "../evidence";
import { withLock } from "../git/GitService";
import { AGENT_DIR, STORE_DIR } from "../paths";
import { proposalStore } from "../store/proposals";
import { runLog } from "../store/runs";
import { readEvidenceTool } from "../tools/readEvidence";
import { proposeRuleChangeTool, readRulebookTool } from "../tools/rulebook";
import { runAgent, type OnEvent, type RunStatus } from "./run";
import { skepticUnlocked, type SkepticResult } from "./skeptic";

export const ANALYST_TOOLS = ["memory", "read_evidence", "read_rulebook", "propose_rule_change"];
const MAX_TURNS = 10;
const MAX_PROPOSALS = 3;

export interface AnalystOptions {
  /** Omit to use every result (the UI does); kept for replays and tests. */
  window?: Required<Window>;
  synthetic?: boolean;
  signal?: AbortSignal; // e.g. the HTTP request: client gone → stop paying for tokens
  onEvent?: OnEvent;
  /** Run the Skeptic on each new proposal after the Analyst finishes (default true). */
  critique?: boolean;
}

export interface AnalystResult {
  runId: string;
  proposalIds: string[];
  status: RunStatus;
  error?: string;
  turns: number;
  costs: SessionCosts;
  skeptic: SkepticResult[];
  totalCostUsd: number;
}

export function runAnalyst(opts: AnalystOptions): Promise<AnalystResult> {
  return withLock(async () => {
    const runId = randomUUID();
    const dir = join(AGENT_DIR, "agents", "analyst");
    const readRules = () => readFileSync(join(AGENT_DIR, "RULES.md"), "utf8");
    // With a window, the Analyst only ever sees rows sent inside it (replays stay honest).
    const rows = filterEvidence(loadEvidence({ synthetic: opts.synthetic }), {}, opts.window ?? {});
    const store = proposalStore(STORE_DIR);
    // Suggestions already waiting for the operator: don't pile up near-duplicates of them.
    const waiting = store.list().filter((p) => p.status === "pending").map((p) => `${p.op} ${p.rule_id ?? "(new rule)"}: ${p.rule_text ?? "retire"}`);

    const analyst = await runAgent({
      agent: "analyst",
      dir,
      prompt: [
        `Evidence: ${opts.window ? `${opts.window.from} to ${opts.window.to}, ` : "all results, "}${rows.length} rows${opts.synthetic ? ", including synthetic rows" : ""}. read_evidence already covers exactly these; do not pass a window.`,
        ...(waiting.length ? [`Already waiting for the operator, do not propose these again or near-copies of them:\n${waiting.map((w) => `- ${w}`).join("\n")}`] : []),
        "Steps:",
        "1. read_evidence with no filter: the baseline.",
        "2. read_evidence with no filter and groupBy, once each for: inbox_type, address_pattern, company_stage, segment, market, duplicate_of_earlier.",
        '   Then repeat groupBy inbox_type and address_pattern inside the biggest split: filter {"market":"IN"} and filter {"market":{"not":"IN"}}.',
        '3. read_rulebook, then memory with {"action":"load"} (proposals the operator already rejected).',
        "4. First decide whether any rule actually needs to change. Only these count as evidence:",
        "   - strong: a slice with 10+ sends whose human-reply rate or bounce rate is at least 5 points from the baseline, with 2+ replies or bounces behind it, and which contradicts or sharpens a current rule;",
        "   - early sign: a slice with at least one interested reply (outcome reply_positive), even if it is small. Suggest trying that approach.",
        "   If nothing meets this bar, make no suggestion: that is a good outcome, not a failure.",
        "5. For each, call read_evidence with that slice's filter to get its sample IDs, then call propose_rule_change: slice = that filter, n = its stats.n, evidence_ids = IDs from that sample, title = a short plain-English name for the change.",
        `Make between 0 and ${MAX_PROPOSALS} proposals. Prefer modifying or retiring a rule the evidence contradicts over adding one.`,
        "If propose_rule_change returns an error, fix the arguments it names and call it again.",
        "Do not write a report: your output is the propose_rule_change calls. Finish with one line listing only the proposal IDs that came back as Stored.",
      ].join("\n"),
      tools: [
        readEvidenceTool(() => rows),
        readRulebookTool(readRules),
        proposeRuleChangeTool({ runId, rows, readRules, store, maxPerRun: MAX_PROPOSALS, window: opts.window, synthetic: opts.synthetic }),
      ],
      allowedTools: ANALYST_TOOLS,
      maxTurns: MAX_TURNS,
      signal: opts.signal,
      onEvent: opts.onEvent,
    });

    const proposalIds = store.list().filter((p) => p.run_id === runId).map((p) => p.id);

    // Sequential on purpose: one agent at a time on the workspace, and a predictable cost.
    const skeptic: AnalystResult["skeptic"] = [];
    if (opts.critique !== false) {
      for (const id of proposalIds) {
        if (opts.signal?.aborted) break;
        try {
          skeptic.push(await skepticUnlocked(id, { signal: opts.signal, onEvent: opts.onEvent }));
        } catch (err) {
          // Recorded on the proposal as critique_error; keep going with the next one.
          skeptic.push({ proposalId: id, runId: "", status: "error", error: (err as Error).message, turns: 0, costs: emptyCosts() });
        }
      }
    }

    const totalCostUsd = analyst.costs.totalCostUsd + skeptic.reduce((s, r) => s + r.costs.totalCostUsd, 0);
    runLog(STORE_DIR).add({ kind: "analyst", status: analyst.status, costUsd: totalCostUsd, window: opts.window, proposalIds });

    return {
      runId,
      proposalIds,
      status: analyst.status,
      ...(analyst.error ? { error: analyst.error } : {}),
      turns: analyst.turns,
      costs: analyst.costs,
      skeptic,
      totalCostUsd,
    };
  });
}

const emptyCosts = (): SessionCosts => ({ totalCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0, totalRequests: 0, startTime: Date.now(), modelUsage: {} });
