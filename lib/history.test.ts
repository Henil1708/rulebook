import { describe, expect, it } from "vitest";
import type { Commit } from "./git/GitService";
import { toHistory } from "./history";

const c = (sha: string, subject: string, body = "", trailers: Record<string, string> = {}): Commit => ({ sha: sha.padEnd(40, "0"), author: "x", date: "2026-10-05T19:22:00Z", subject, body, trailers });

describe("toHistory", () => {
  it("says what each commit did in plain words, and which ones can still be undone", () => {
    const rule = c("a", "rule(R-003): modify — Use the careers@ inbox", "", { N: "43", "Edited-By": "operator" });
    const items = toHistory([
      c("c", 'Revert "rule(R-003): modify — Use the careers@ inbox"', `This reverts commit ${"a".padEnd(40, "0")}.`),
      c("b", "memory(analyst): rejected 3 proposals (P-004, P-005, P-006) — most replies were rejections"),
      rule,
      c("d", "init: rulebook v0 (July 2026 strategy)"),
    ]);
    expect(items.map((i) => [i.title, i.undoable, i.undone])).toEqual([
      ["You cancelled the change to Rule 3", false, false],
      ["You turned down 3 suggestions", true, false],
      ["You changed Rule 3", false, true],
      ["Your starting rules", false, false],
    ]);
    expect(items[0].detail).toBe("Rule 3 is back to how it was.");
    expect(items[1].detail).toBe('Your reason: "most replies were rejections"');
    expect(items[2]).toMatchObject({ detail: 'New wording: "Use the careers@ inbox"', note: "Based on 43 of your emails. In your own words." });
  });
});
