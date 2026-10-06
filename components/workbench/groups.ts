// Waiting suggestions grouped by the rule they change, strongest first, so the operator decides once per rule.
import type { Proposal } from "@/lib/store/proposals";

export interface RuleGroup {
  key: string; // the rule ID, or the proposal ID for a brand-new rule
  ruleId?: string;
  suggestions: Proposal[];
  /** Every suggestion has a reviewer verdict of "oppose". */
  against: boolean;
}

const RANK: Record<string, number> = { support: 3, caution: 2, oppose: 0 };
export const rank = (p: Proposal) => p.critique ? RANK[p.critique.verdict] : 1;
const sureness = (p: Proposal) => p.critique?.adjusted_confidence ?? p.confidence;

export function strongestFirst(a: Proposal, b: Proposal): number {
  return rank(b) - rank(a) || sureness(b) - sureness(a) || b.check.n - a.check.n;
}

export function groupByRule(proposals: Proposal[]): RuleGroup[] {
  const groups = new Map<string, Proposal[]>();
  for (const p of proposals) {
    if (p.status !== "pending") continue;
    const key = p.op === "add" || !p.rule_id ? p.id : p.rule_id;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  return [...groups.entries()]
    .map(([key, ps]) => {
      const suggestions = ps.sort(strongestFirst);
      return { key, ruleId: suggestions[0].op === "add" ? undefined : suggestions[0].rule_id, suggestions, against: suggestions.every((p) => p.critique?.verdict === "oppose") };
    })
    .sort((a, b) => Number(a.against) - Number(b.against) || strongestFirst(a.suggestions[0], b.suggestions[0]));
}

/** A short name for a suggestion: the Analyst's title, or the start of its wording. */
export function titleOf(p: Proposal): string {
  if (p.title) return p.title;
  if (p.op === "retire") return "Remove this rule";
  const words = (p.rule_text ?? "").split(/\s+/);
  return words.length > 9 ? `${words.slice(0, 9).join(" ")}…` : words.join(" ");
}
