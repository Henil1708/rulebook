// runAnalyst: one Analyst query() over a window of evidence, under the workspace lock.
import { query, type GCMessage, type SessionCosts } from "@open-gitagent/gitagent";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { filterEvidence, loadEvidence, type Window } from "../evidence";
import { withLock } from "../git/GitService";
import { AGENT_DIR, STORE_DIR } from "../paths";
import { proposalStore } from "../store/proposals";
import { readEvidenceTool } from "../tools/readEvidence";
import { proposeRuleChangeTool, readRulebookTool } from "../tools/rulebook";
import { createGuard } from "./hooks";

export const ANALYST_TOOLS = ["memory", "read_evidence", "read_rulebook", "propose_rule_change"];
const MAX_TURNS = 10;
const MAX_PROPOSALS = 3;

export interface AnalystOptions {
  window: Required<Window>;
  synthetic?: boolean;
  signal?: AbortSignal; // e.g. the HTTP request: client gone → stop paying for tokens
  onEvent?: (m: GCMessage) => void;
}

export interface AnalystResult {
  runId: string;
  proposalIds: string[];
  status: "done" | "aborted" | "timeout" | "turn_limit" | "error";
  error?: string;
  turns: number;
  costs: SessionCosts;
}

const model = () => process.env.RULEBOOK_MODEL || "openai:gpt-4o-mini";
const timeoutMs = () => Number(process.env.RULEBOOK_RUN_TIMEOUT_MS || 90_000);

export function runAnalyst(opts: AnalystOptions): Promise<AnalystResult> {
  return withLock(async () => {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
    const runId = randomUUID();
    const dir = join(AGENT_DIR, "agents", "analyst");
    const readRules = () => readFileSync(join(AGENT_DIR, "RULES.md"), "utf8");
    // The Analyst only ever sees rows sent inside the window (replays stay honest).
    const rows = filterEvidence(loadEvidence({ synthetic: opts.synthetic }), {}, opts.window);
    const store = proposalStore(STORE_DIR);

    const ac = new AbortController();
    const guard = createGuard({ agent: "analyst", agentDir: dir, allowedTools: ANALYST_TOOLS, maxTurns: MAX_TURNS, abortController: ac });
    let timedOut = false;
    const timer = setTimeout(() => ((timedOut = true), ac.abort()), timeoutMs());
    const onClientAbort = () => ac.abort();
    opts.signal?.addEventListener("abort", onClientAbort, { once: true });

    const q = query({
      dir,
      model: model(),
      prompt: [
        `Evidence window: ${opts.window.from} to ${opts.window.to} (${rows.length} rows${opts.synthetic ? ", including synthetic rows" : ""}).`,
        "Steps:",
        "1. read_evidence with no filter: the baseline.",
        "2. read_evidence with no filter and groupBy, once each for: inbox_type, address_pattern, company_stage, segment, market, duplicate_of_earlier.",
        '   Then repeat groupBy inbox_type and address_pattern inside the biggest split: filter {"market":"IN"} and filter {"market":{"not":"IN"}}.',
        '3. read_rulebook, then memory with {"action":"load"} (proposals the operator already rejected).',
        "4. Pick the slices (n >= 10) whose human-reply rate or bounce rate differs most from the baseline, ideally ones that contradict a current rule.",
        "5. For each, call read_evidence with that slice's filter to get its sample IDs, then call propose_rule_change: slice = that filter, n = its stats.n, evidence_ids = IDs from that sample.",
        `Make between 1 and ${MAX_PROPOSALS} proposals. Prefer modifying or retiring a rule the evidence contradicts over adding one.`,
        "If propose_rule_change returns an error, fix the arguments it names and call it again.",
        "Do not write a report: your output is the propose_rule_change calls. Finish with one line listing only the proposal IDs that came back as Stored.",
      ].join("\n"),
      tools: [
        readEvidenceTool(() => rows),
        readRulebookTool(readRules),
        proposeRuleChangeTool({ runId, rows, readRules, store, maxPerRun: MAX_PROPOSALS }),
      ],
      allowedTools: ANALYST_TOOLS,
      hooks: { preToolUse: guard.preToolUse },
      maxTurns: MAX_TURNS, // ignored by gitagent 2.2.0; the guard enforces it
      abortController: ac,
    });

    let error: string | undefined;
    try {
      for await (const m of q) {
        guard.onMessage(m);
        if (m.type === "system" && m.subtype === "error") error = m.content;
        opts.onEvent?.(m);
      }
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onClientAbort);
    }

    const status: AnalystResult["status"] = timedOut
      ? "timeout"
      : opts.signal?.aborted
        ? "aborted"
        : guard.turns() >= MAX_TURNS && ac.signal.aborted
          ? "turn_limit"
          : error
            ? "error"
            : "done";
    return {
      runId,
      proposalIds: store.list().filter((p) => p.run_id === runId).map((p) => p.id),
      status,
      ...(error ? { error } : {}),
      turns: guard.turns(),
      costs: q.costs(),
    };
  });
}
