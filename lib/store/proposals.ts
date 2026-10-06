// Proposals live in workspace/.rulebook/proposals.json: working state, not history (history is git).
// Writes are synchronous read-modify-write + rename, so they can't interleave inside one process and
// are safe to call from a tool handler while the run holds the workspace lock.
import { join } from "node:path";
import { readJson, writeJson } from "./json";
import type { Filter } from "../evidence";
import type { ProposalOp } from "../rules";

/** superseded = closed because another suggestion for the same rule was applied. draft = a combined
 * suggestion waiting for the operator in the combine sheet (not listed until applied). */
export type ProposalStatus = "pending" | "accepted" | "rejected" | "superseded" | "draft";
export type Verdict = "support" | "caution" | "oppose";

export interface Critique {
  run_id: string;
  at: string;
  verdict: Verdict;
  adjusted_confidence: number;
  concerns: string[];
  what_would_change_my_mind: string;
  /** Set when code overrode the model's verdict (e.g. n < 10 can't be "support"). Shown to the operator. */
  override?: { model_verdict: Verdict; reason: string };
}

export interface Proposal {
  id: string; // P-###
  status: ProposalStatus;
  created_at: string;
  run_id: string;
  /** The evidence the Analyst saw, so the Skeptic reviews the same rows. */
  window?: { from: string; to: string };
  synthetic?: boolean;
  op: ProposalOp;
  /** Short plain-language name for the change, e.g. "Prefer careers@ inboxes". */
  title?: string;
  /** A combined suggestion: the IDs it was made from. Its evidence is the union of theirs. */
  combines?: string[];
  rule_id?: string;
  rule_text?: string;
  evidence_ids: string[];
  slice: Filter;
  n: number;
  metric: string;
  rationale: string;
  confidence: number;
  /** Recomputed by the server from `slice` over the run's evidence; the model's metric text is never trusted on its own. */
  check: { n: number; humanReplies: number; bounces: number; positive?: number };
  /** strong = clear evidence for a rule change; early = an interested reply in a small group, worth trying first. */
  evidence_level?: "strong" | "early";
  critique?: Critique;
  /** Set when the Skeptic ran but didn't submit a critique (timeout, error, no call). */
  critique_error?: string;
  /** Set when the operator decides. */
  decision?: {
    at: string;
    sha: string; // the rule commit (accept) or memory commit (reject)
    rule_id?: string; // accept: the ID the change landed on (new for add)
    final_text?: string; // accept: the text committed, if it differs from rule_text (operator edit)
    reason?: string; // reject
    note?: string; // superseded: which suggestion replaced it
  };
}

export type NewProposal = Omit<Proposal, "id" | "status" | "created_at">;

export function proposalStore(dir: string) {
  const file = join(dir, "proposals.json");

  const list = (): Proposal[] => readJson<Proposal[]>(file, []);
  const save = (all: Proposal[]) => writeJson(file, all);

  return {
    list,
    get: (id: string) => list().find((p) => p.id === id),
    add(input: NewProposal): Proposal {
      const all = list();
      const next = Math.max(0, ...all.map((p) => Number(p.id.slice(2)))) + 1;
      const p: Proposal = { id: `P-${String(next).padStart(3, "0")}`, status: "pending", created_at: new Date().toISOString(), ...input };
      if (input.combines) p.status = "draft";
      save([...all, p]);
      return p;
    },
    update(id: string, patch: Partial<Pick<Proposal, "status" | "decision" | "critique" | "critique_error">>): Proposal {
      const all = list();
      const i = all.findIndex((p) => p.id === id);
      if (i === -1) throw new Error(`${id} not found`);
      all[i] = { ...all[i], ...patch };
      save(all);
      return all[i];
    },
  };
}

export type ProposalStore = ReturnType<typeof proposalStore>;
