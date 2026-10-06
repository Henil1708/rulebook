// The workspace's git log in everyday words for the History panel. Pure: commits in, items out.
import type { Commit } from "./git/GitService";

export interface HistoryItem {
  sha: string;
  date: string;
  /** What happened, e.g. "You changed Rule 3". */
  title: string;
  /** The wording or reason, quoted. */
  detail: string;
  /** Small print, e.g. "Based on 22 of your emails. Merged from 2 suggestions." */
  note?: string;
  /** A rule change or turn-down that is still in effect, so it can be cancelled. */
  undoable: boolean;
  /** Cancelled later by an undo. */
  undone: boolean;
  /** For the timeline filter. */
  kind: "rule" | "dismiss" | "undo" | "start";
}

const ruleName = (id: string) => `Rule ${Number(id.slice(2))}`;
const VERB: Record<string, string> = { add: "added", modify: "changed", retire: "removed" };
const RULE = /^rule\((R-\d+)\): (add|modify|retire) — (.*)$/;
const TURNED_DOWN = /^memory\(analyst\): rejected (.+?) — (.*)$/;
const count = (ids: string) => Number(/^(\d+) proposals/.exec(ids)?.[1] ?? 1);
const many = (n: number, one: string, more = `${one}s`) => `${n} ${n === 1 ? one : more}`;

function describe(c: Commit): Pick<HistoryItem, "title" | "detail" | "note" | "kind"> {
  const rule = RULE.exec(c.subject);
  if (rule) {
    const t = c.trailers;
    const how = t.Combines ? `Merged from ${many(t.Combines.split(",").length, "suggestion")}.` : t["Edited-By"] ? "In your own words." : "";
    const based = t.N ? `Based on ${t.N} of your email${t.N === "1" ? "" : "s"}.` : "";
    return {
      kind: "rule",
      title: `You ${VERB[rule[2]]} ${ruleName(rule[1])}`,
      detail: rule[2] === "retire" ? `It said: "${rule[3]}"` : `New wording: "${rule[3]}"`,
      note: [based, how].filter(Boolean).join(" ") || undefined,
    };
  }
  const down = TURNED_DOWN.exec(c.subject);
  if (down) return { kind: "dismiss", title: `You turned down ${many(count(down[1]), "suggestion")}`, detail: `Your reason: "${down[2]}"` };
  if (/^init:/.test(c.subject)) return { kind: "start", title: "Your starting rules", detail: "The rules from your July plan, before any results." };
  return { kind: "rule", title: c.subject, detail: "" };
}

/** What an undo did, said from the operator's side. */
function describeUndo(original: string): Pick<HistoryItem, "title" | "detail"> {
  const rule = RULE.exec(original);
  if (rule) {
    const name = ruleName(rule[1]);
    return rule[2] === "add"
      ? { title: `You took back ${name}`, detail: `${name} is no longer in your rules.` }
      : { title: `You cancelled the change to ${name}`, detail: `${name} is back to how it was.` };
  }
  const down = TURNED_DOWN.exec(original);
  if (down) {
    const n = count(down[1]);
    return { title: `You brought back ${many(n, "suggestion")}`, detail: `${n === 1 ? "It's" : "They're"} waiting for you again.` };
  }
  return { title: `You cancelled: ${original}`, detail: "" };
}

/** Newest first, as git log returns them. */
export function toHistory(log: Commit[]): HistoryItem[] {
  const reverted = new Set(log.flatMap((c) => [...c.body.matchAll(/This reverts commit ([0-9a-f]{40})/g)].map((m) => m[1])));
  return log.map((c) => {
    const undo = /^Revert "(.*)"$/.exec(c.subject);
    if (undo) return { sha: c.sha, date: c.date, ...describeUndo(undo[1]), kind: "undo", undoable: false, undone: false };
    const undone = reverted.has(c.sha);
    return { sha: c.sha, date: c.date, ...describe(c), undoable: /^(rule\(|memory\(analyst\))/.test(c.subject) && !undone, undone };
  });
}
