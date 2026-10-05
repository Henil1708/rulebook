// The operator's decision on a proposal. Accept = a rule commit with trailers (CLAUDE.md §4).
// Reject = a memory commit the Analyst reads next run. Both check and record the decision inside the lock.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Filter } from "./evidence";
import type { GitService } from "./git/GitService";
import { sanitiseMessage, type Trailers } from "./git/message";
import { applyProposal, cleanRuleText, nextRuleId, parseRules } from "./rules";
import type { Proposal, ProposalStore } from "./store/proposals";

export const RULES_PATH = "RULES.md";
/** The Analyst runs from agents/analyst, so its memory tool reads this file. */
export const ANALYST_MEMORY_PATH = "agents/analyst/memory/MEMORY.md";

export class ReviewError extends Error {
  constructor(message: string, readonly status: 404 | 409 | 400) {
    super(message);
  }
}

interface Deps {
  git: GitService;
  store: ProposalStore;
}

function pending(store: ProposalStore, id: string): Proposal {
  const p = store.get(id);
  if (!p) throw new ReviewError(`${id} not found`, 404);
  if (p.status !== "pending") throw new ReviewError(`${id} is already ${p.status}`, 409);
  return p;
}

/** `{market:{not:"IN"}, inbox_type:"named_person"}` → `market!=IN & inbox_type=named_person`. */
export function renderSlice(filter: Filter): string {
  const parts = Object.entries(filter).map(([k, f]) => {
    const list = (v: unknown) => (Array.isArray(v) ? v.join("|") : String(v));
    return typeof f === "object" && f !== null && !Array.isArray(f) ? `${k}!=${list(f.not)}` : `${k}=${list(f)}`;
  });
  return parts.join(" & ") || "all";
}

/** Every rule ID that ever existed: current file plus every `rule(R-###)` subject in history. */
async function seenRuleIds(git: GitService, rules: string): Promise<string[]> {
  const subjects = (await git.log({ max: 10_000 })).map((c) => c.subject);
  return [...parseRules(rules).map((r) => r.id), ...subjects.flatMap((s) => [...s.matchAll(/\b(R-\d{3,})\b/g)].map((m) => m[1]))];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const short = (text: string, max = 90) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

export async function acceptProposal({ git, store }: Deps, id: string, editedText?: string) {
  pending(store, id); // fast 404/409 before queueing; re-checked inside the lock
  let result!: Proposal;

  const sha = await git.commit(async () => {
    const p = pending(store, id);
    if (editedText !== undefined && p.op === "retire") throw new ReviewError("a retire has no text to edit", 400);
    const text = editedText !== undefined ? cleanRuleText(editedText) : p.rule_text;
    if (editedText !== undefined && (!text || text.length < 10)) throw new ReviewError("edited text must be at least 10 characters", 400);

    const rules = await readFile(join(git.cwd, RULES_PATH), "utf8");
    const ruleId = p.op === "add" ? nextRuleId(await seenRuleIds(git, rules)) : p.rule_id!;
    const old = parseRules(rules).find((r) => r.id === ruleId)?.text;
    let next: string;
    try {
      next = applyProposal(rules, { op: p.op, rule_id: ruleId, rule_text: text }, ruleId);
    } catch (err) {
      throw new ReviewError(`${id} no longer applies: ${(err as Error).message}`, 409); // rulebook changed since the proposal
    }

    const sources = new Set(p.evidence_ids.map((e) => (e.startsWith("syn-") ? "synthetic" : "gmail")));
    const trailers: Trailers = {
      Proposal: p.id,
      Evidence: p.evidence_ids.join(", "),
      Slice: renderSlice(p.slice),
      N: String(p.check.n),
      Metric: `${plural(p.check.humanReplies, "human reply", "human replies")}, ${plural(p.check.bounces, "bounce", "bounces")}`,
      "Proposed-By": "analyst",
      ...(editedText !== undefined && text !== p.rule_text ? { "Edited-By": "operator" } : {}),
      "Approved-By": "operator",
      "Evidence-Source": [...sources].sort().join(", "),
    };
    return {
      files: { [RULES_PATH]: next },
      message: `rule(${ruleId}): ${p.op} — ${short(p.op === "retire" ? (old ?? ruleId) : text!)}`,
      trailers,
      after: (sha: string) => {
        result = store.update(id, {
          status: "accepted",
          decision: { at: new Date().toISOString(), sha, rule_id: ruleId, ...(text !== p.rule_text ? { final_text: text } : {}) },
        });
      },
    };
  });
  return { proposal: result, sha };
}

export async function rejectProposal({ git, store }: Deps, id: string, reason: string) {
  const clean = sanitiseMessage(reason, 200); // for the commit message only
  if (clean.length < 3) throw new ReviewError("a reason is required", 400);
  const said = reason.replace(/\s+/g, " ").trim().slice(0, 500); // as the operator wrote it, on one line
  pending(store, id);
  let result!: Proposal;

  const sha = await git.commit(async () => {
    const p = pending(store, id); // inside the lock: a concurrent accept/reject wins and this one stops before committing
    const what = `${p.op}${p.rule_id ? ` ${p.rule_id}` : ""}${p.rule_text ? `: ${p.rule_text}` : ""}`;
    // File content, not a command: flatten to one line (one memory entry per line) but keep characters like "@".
    const line = `Rejected ${p.id} (${what}; slice ${renderSlice(p.slice)}, n=${p.check.n}). Reason: ${said}`.slice(0, 800);
    const current = await readFile(join(git.cwd, ANALYST_MEMORY_PATH), "utf8").catch(() => "");
    return {
      files: { [ANALYST_MEMORY_PATH]: `${current}- ${line}\n` },
      message: sanitiseMessage(`memory(analyst): rejected ${p.id} — ${clean}`, 200),
      after: (sha: string) => {
        result = store.update(id, { status: "rejected", decision: { at: new Date().toISOString(), sha, reason: said } });
      },
    };
  });
  return { proposal: result, sha };
}
