// RULES.md as data: parse rule lines, apply a proposal, allocate the next ID. Pure functions.

export interface Rule {
  id: string; // R-###
  text: string;
}

export type ProposalOp = "add" | "modify" | "retire";

export interface RuleChange {
  op: ProposalOp;
  rule_id?: string; // required for modify/retire
  rule_text?: string; // required for add/modify
}

const RULE_LINE = /^- \[(R-\d{3,})\] (.+)$/;
export const RULE_ID = /^R-\d{3,}$/;

/** Rule lines are `- [R-###] text`. Everything else (title, comments) is ignored. */
export function parseRules(markdown: string): Rule[] {
  const rules: Rule[] = [];
  for (const line of markdown.split("\n")) {
    const m = RULE_LINE.exec(line.trim());
    if (m) rules.push({ id: m[1], text: m[2].trim() });
  }
  return rules;
}

/** IDs are never reused, so pass every ID ever seen (current file + git history + pending proposals). */
export function nextRuleId(seenIds: Iterable<string>): string {
  let max = 0;
  for (const id of seenIds) if (RULE_ID.test(id)) max = Math.max(max, Number(id.slice(2)));
  return `R-${String(max + 1).padStart(3, "0")}`;
}

/** One line, no leading list marker or ID, so the model can't smuggle extra rules into the file. */
export function cleanRuleText(text: string): string {
  return text.replace(/\s+/g, " ").replace(/^(-\s*)?(\[R-\d+\]\s*)?/, "").trim();
}

/**
 * Apply a change to the RULES.md text and return the new text. Untouched lines (header, comments,
 * other rules) are preserved byte for byte. `add` appends after the last rule and needs `newId`.
 */
export function applyProposal(markdown: string, change: RuleChange, newId?: string): string {
  const lines = markdown.split("\n");
  const at = (id: string) => lines.findIndex((l) => RULE_LINE.exec(l.trim())?.[1] === id);

  if (change.op === "add") {
    if (!newId || !RULE_ID.test(newId)) throw new Error("add needs a new rule ID");
    if (at(newId) !== -1) throw new Error(`${newId} already exists`);
    const text = cleanRuleText(change.rule_text ?? "");
    if (!text) throw new Error("add needs rule_text");
    let last = -1;
    lines.forEach((l, i) => RULE_LINE.test(l.trim()) && (last = i));
    if (last === -1) {
      // No rules yet: append at the end, keeping one trailing newline.
      while (lines.length && lines[lines.length - 1] === "") lines.pop();
      return [...lines, "", `- [${newId}] ${text}`, ""].join("\n");
    }
    lines.splice(last + 1, 0, `- [${newId}] ${text}`);
    return lines.join("\n");
  }

  const id = change.rule_id ?? "";
  const i = at(id);
  if (i === -1) throw new Error(`${id || "rule_id"} is not in the rulebook`);
  if (change.op === "retire") {
    lines.splice(i, 1);
    return lines.join("\n");
  }
  const text = cleanRuleText(change.rule_text ?? "");
  if (!text) throw new Error("modify needs rule_text");
  lines[i] = `- [${id}] ${text}`;
  return lines.join("\n");
}
