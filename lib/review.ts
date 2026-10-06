// The operator's decision on a proposal. Accept = a rule commit with trailers (CLAUDE.md §4).
// Reject = a memory commit the Analyst reads next run. Both check and record the decision inside the lock.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { filterEvidence, type Evidence, type Filter } from "./evidence";
import type { GitService } from "./git/GitService";
import { sanitiseMessage, type Trailers } from "./git/message";
import { applyProposal, cleanRuleText, nextRuleId, parseRules } from "./rules";
import type { Proposal, ProposalStore } from "./store/proposals";

export const RULES_PATH = "RULES.md";
/** The Analyst runs from agents/analyst, so its memory tool reads this file. */
export const ANALYST_MEMORY_PATH = "agents/analyst/memory/MEMORY.md";

export class ReviewError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 402 | 404 | 409 | 503,
    /** Machine-readable reason the UI can switch on, e.g. "busy" or "missing_key". */
    readonly code?: string,
  ) {
    super(message);
  }
}

interface Deps {
  git: GitService;
  store: ProposalStore;
}

/** A suggestion the operator can still decide on. A draft is a combined suggestion from the combine sheet. */
function pending(store: ProposalStore, id: string, allowDraft = false): Proposal {
  const p = store.get(id);
  if (!p) throw new ReviewError(`${id} not found`, 404);
  if (p.status !== "pending" && !(allowDraft && p.status === "draft")) throw new ReviewError(`${id} is already ${p.status}`, 409);
  return p;
}

/** One memory line per closed suggestion, so the Analyst doesn't suggest it again. */
function memoryLine(p: Proposal, verdict: string): string {
  const what = `${p.op}${p.rule_id ? ` ${p.rule_id}` : ""}${p.rule_text ? `: ${p.rule_text}` : ""}`;
  return `- ${`${verdict} ${p.id} (${what}; slice ${renderSlice(p.slice)}, n=${p.check.n})`.slice(0, 800)}\n`;
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

/** The emails behind a suggestion: its slice, or for a combined one the union of its parts' slices. */
export function proposalRows(all: Evidence[], p: Proposal, get: (id: string) => Proposal | undefined): Evidence[] {
  if (!p.combines) return filterEvidence(all, p.slice, p.window ?? {});
  const byId = new Map<string, Evidence>();
  for (const m of p.combines.map(get)) if (m) for (const r of filterEvidence(all, m.slice, m.window ?? {})) byId.set(r.id, r);
  return [...byId.values()];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const short = (text: string, max = 90) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

export async function acceptProposal({ git, store }: Deps, id: string, editedText?: string) {
  pending(store, id, true); // fast 404/409 before queueing; re-checked inside the lock
  let result!: Proposal;

  const sha = await git.commit(async () => {
    const p = pending(store, id, true);
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
      ...(p.critique ? { Critique: `${p.critique.verdict} (${p.critique.adjusted_confidence.toFixed(2)}) — skeptic` } : {}),
      ...(p.critique?.override
        ? { "Critique-Override": `${p.critique.override.model_verdict} -> ${p.critique.verdict}, ${p.critique.override.reason}` }
        : {}),
      ...(editedText !== undefined && text !== p.rule_text ? { "Edited-By": "operator" } : {}),
      ...(p.evidence_level === "early" ? { "Evidence-Level": "early sign, worth trying" } : {}),
      "Approved-By": "operator",
      "Evidence-Source": [...sources].sort().join(", "),
    };
    // The other suggestions for this rule are answered by this change: close them as replaced, in the same commit.
    const replaced = p.op === "add" ? [] : store.list().filter((x) => x.id !== p.id && x.rule_id === ruleId && (x.status === "pending" || x.status === "draft"));
    if (p.combines) trailers.Combines = p.combines.join(", ");
    if (replaced.length) trailers.Replaces = replaced.map((x) => x.id).join(", ");
    const memory = await readFile(join(git.cwd, ANALYST_MEMORY_PATH), "utf8").catch(() => "");
    const files: Record<string, string> = { [RULES_PATH]: next };
    const closed = replaced.filter((x) => x.status === "pending");
    if (closed.length) files[ANALYST_MEMORY_PATH] = memory + closed.map((x) => memoryLine(x, `Replaced by ${p.id}:`)).join("");
    return {
      files,
      message: `rule(${ruleId}): ${p.op} — ${short(p.op === "retire" ? (old ?? ruleId) : text!)}`,
      trailers,
      after: (sha: string) => {
        const at = new Date().toISOString();
        result = store.update(id, {
          status: "accepted",
          decision: { at, sha, rule_id: ruleId, ...(text !== p.rule_text ? { final_text: text } : {}) },
        });
        for (const x of replaced) store.update(x.id, { status: "superseded", decision: { at, sha, note: `Replaced by ${p.id}` } });
      },
    };
  });
  return { proposal: result, sha };
}

/** Dismiss one or more suggestions with one reason: one memory commit the Analyst reads next run. */
export async function rejectProposals({ git, store }: Deps, ids: string[], reason: string) {
  const clean = sanitiseMessage(reason, 200); // for the commit message only
  if (clean.length < 3) throw new ReviewError("a reason is required", 400);
  if (!ids.length) throw new ReviewError("nothing to dismiss", 400);
  const said = reason.replace(/\s+/g, " ").trim().slice(0, 500); // as the operator wrote it, on one line
  ids.forEach((id) => pending(store, id));
  const result: Proposal[] = [];

  const sha = await git.commit(async () => {
    const ps = ids.map((id) => pending(store, id)); // inside the lock: a concurrent decision wins and this one stops before committing
    // File content, not a command: flattened to one line per suggestion, characters like "@" kept.
    const lines = ps.map((p) => memoryLine(p, "Rejected").replace(/\n$/, `. Reason: ${said}\n`)).join("");
    const current = await readFile(join(git.cwd, ANALYST_MEMORY_PATH), "utf8").catch(() => "");
    const label = ps.length === 1 ? ps[0].id : `${ps.length} proposals (${ps.map((p) => p.id).join(", ")})`;
    return {
      files: { [ANALYST_MEMORY_PATH]: current + lines },
      message: sanitiseMessage(`memory(analyst): rejected ${label} — ${clean}`, 200),
      after: (sha: string) => {
        const at = new Date().toISOString();
        for (const p of ps) result.push(store.update(p.id, { status: "rejected", decision: { at, sha, reason: said } }));
      },
    };
  });
  return { proposals: result, sha };
}

export async function rejectProposal(deps: Deps, id: string, reason: string) {
  const { proposals, sha } = await rejectProposals(deps, [id], reason);
  return { proposal: proposals[0], sha };
}

/** Undo one rule or memory commit with `git revert` (history is never rewritten); its suggestions wait again. */
export async function undoChange({ git, store }: Deps, sha: string) {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new ReviewError("not a commit", 400);
  const log = await git.log({ max: 10_000 });
  const c = log.find((x) => x.sha.startsWith(sha));
  if (!c) throw new ReviewError("change not found", 404);
  if (!/^(rule\(|memory\(analyst\))/.test(c.subject)) throw new ReviewError("only rule changes and dismissals can be undone", 400);
  if (log.some((x) => x.body.includes(`This reverts commit ${c.sha}`))) throw new ReviewError("this change is already undone", 409);
  let restored: string[] = [];
  const head = await git.revert(c.sha, () => {
    const back = store.list().filter((p) => p.decision?.sha === c.sha);
    // A combined suggestion goes back to being a hidden draft; the suggestions it was made from wait again.
    for (const p of back) store.update(p.id, { status: p.combines ? "draft" : "pending", decision: undefined });
    restored = back.filter((p) => !p.combines).map((p) => p.id);
  }).catch((err: Error) => {
    if (/conflict|could not revert/i.test(err.message)) throw new ReviewError("A later change touched the same rule. Undo that one first.", 409, "conflict");
    throw err;
  });
  return { sha: head, restored };
}
