// combineProposals: the operator ticked several suggestions for one rule. The root agent (the Drafter, which
// follows RULES.md) writes one combined wording, it's stored as a draft suggestion, and the Skeptic reviews it.
import { randomUUID } from "node:crypto";
import { isSend, loadEvidence, stats } from "../evidence";
import { withLock } from "../git/GitService";
import { AGENT_DIR, STORE_DIR } from "../paths";
import { proposalRows, ReviewError } from "../review";
import { cleanRuleText } from "../rules";
import { proposalStore, type Proposal } from "../store/proposals";
import { runLog } from "../store/runs";
import { runAgent } from "./run";
import { skepticUnlocked } from "./skeptic";

export async function combineProposals(ids: string[], opts: { signal?: AbortSignal } = {}): Promise<{ proposal: Proposal; costUsd: number }> {
  return withLock(async () => {
    const store = proposalStore(STORE_DIR);
    const parts = [...new Set(ids)].map((id) => store.get(id));
    if (parts.length < 2) throw new ReviewError("pick at least 2 suggestions to combine", 400);
    for (const [i, p] of parts.entries()) {
      if (!p) throw new ReviewError(`${ids[i]} not found`, 404);
      if (p.status !== "pending") throw new ReviewError(`${p.id} is already ${p.status}`, 409);
    }
    const ps = parts as Proposal[];
    const ruleId = ps[0].rule_id;
    if (!ruleId || ps.some((p) => p.rule_id !== ruleId || p.op !== "modify")) throw new ReviewError("only rewordings of the same rule can be combined", 400);

    let text = "";
    const draft = await runAgent({
      agent: "drafter",
      dir: AGENT_DIR,
      prompt: [
        `Combine these suggested rewordings of rule ${ruleId} into ONE rule: a single plain sentence, at most 280 characters, that keeps what they agree on.`,
        ...ps.map((p) => `- ${p.rule_text}`),
        "Reply with only the new rule sentence. No ID, no quotes, no explanation.",
      ].join("\n"),
      tools: [],
      allowedTools: [],
      maxTurns: 2, // one answer is all we need; the guard aborts a second turn
      signal: opts.signal,
      onEvent: (m) => {
        if (m.type === "assistant" && typeof m.content === "string" && m.content.trim()) text = m.content;
      },
    });
    const ruleText = cleanRuleText(text.replace(/^["'\s]+|["'\s]+$/g, "")).slice(0, 300);
    if ((draft.status !== "done" && draft.status !== "turn_limit") || ruleText.length < 10) {
      runLog(STORE_DIR).add({ kind: "combine", status: draft.status, costUsd: draft.costs.totalCostUsd, proposalIds: [] });
      throw new ReviewError(`The AI couldn't draft a combined wording (${draft.error ?? draft.status}). Try again.`, 503, "draft_failed");
    }

    const all = loadEvidence({ synthetic: ps.some((p) => p.synthetic) });
    const combined: Omit<Proposal, "id" | "status" | "created_at"> = {
      run_id: randomUUID(),
      op: "modify",
      rule_id: ruleId,
      rule_text: ruleText,
      title: "Combined wording",
      combines: ps.map((p) => p.id),
      evidence_ids: [...new Set(ps.flatMap((p) => p.evidence_ids))],
      slice: {},
      n: 0,
      metric: ps.map((p) => p.metric).join("; ").slice(0, 200),
      rationale: `Combined from ${ps.map((p) => p.id).join(", ")} by the operator.`,
      confidence: Math.min(...ps.map((p) => p.confidence)),
      check: { n: 0, humanReplies: 0, bounces: 0 },
      ...(ps.some((p) => p.synthetic) ? { synthetic: true } : {}),
    };
    // n and the outcome counts come from the union of the parts' emails, never from the model.
    const s = stats(proposalRows(all, combined as Proposal, store.get).filter(isSend));
    const draftP = store.add({ ...combined, n: s.n, check: { n: s.n, humanReplies: s.humanReplies, bounces: s.bounces } });

    const review = await skepticUnlocked(draftP.id, { signal: opts.signal }).catch(() => undefined);
    const costUsd = draft.costs.totalCostUsd + (review?.costs.totalCostUsd ?? 0);
    runLog(STORE_DIR).add({ kind: "combine", status: review?.status ?? "error", costUsd, proposalIds: [draftP.id] });
    return { proposal: store.get(draftP.id)!, costUsd };
  });
}
