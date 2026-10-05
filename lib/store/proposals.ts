// Proposals live in workspace/.rulebook/proposals.json: working state, not history (history is git).
// Writes are synchronous read-modify-write + rename, so they can't interleave inside one process and
// are safe to call from a tool handler while the run holds the workspace lock.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Filter } from "../evidence";
import type { ProposalOp } from "../rules";

export type ProposalStatus = "pending" | "accepted" | "rejected";

export interface Proposal {
  id: string; // P-###
  status: ProposalStatus;
  created_at: string;
  run_id: string;
  op: ProposalOp;
  rule_id?: string;
  rule_text?: string;
  evidence_ids: string[];
  slice: Filter;
  n: number;
  metric: string;
  rationale: string;
  confidence: number;
  /** Recomputed by the server from `slice` over the run's evidence; the model's metric text is never trusted on its own. */
  check: { n: number; humanReplies: number; bounces: number };
  /** Set when the operator decides. */
  decision?: {
    at: string;
    sha: string; // the rule commit (accept) or memory commit (reject)
    rule_id?: string; // accept: the ID the change landed on (new for add)
    final_text?: string; // accept: the text committed, if it differs from rule_text (operator edit)
    reason?: string; // reject
  };
}

export type NewProposal = Omit<Proposal, "id" | "status" | "created_at">;

export function proposalStore(dir: string) {
  const file = join(dir, "proposals.json");

  function list(): Proposal[] {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Proposal[]) : [];
  }

  function save(all: Proposal[]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(all, null, 2) + "\n");
    renameSync(`${file}.tmp`, file);
  }

  return {
    list,
    get: (id: string) => list().find((p) => p.id === id),
    add(input: NewProposal): Proposal {
      const all = list();
      const next = Math.max(0, ...all.map((p) => Number(p.id.slice(2)))) + 1;
      const p: Proposal = { id: `P-${String(next).padStart(3, "0")}`, status: "pending", created_at: new Date().toISOString(), ...input };
      save([...all, p]);
      return p;
    },
    update(id: string, patch: Partial<Pick<Proposal, "status" | "decision">>): Proposal {
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
