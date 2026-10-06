import { describe, expect, it } from "vitest";
import { collapse, narrate } from "./narrate";

const evidence = (query: object, stats: object) => JSON.stringify({ query, stats });

describe("narrate", () => {
  it("says what each step found, in plain words", () => {
    expect(narrate("read_evidence", {}, evidence({ filter: {} }, { n: 142, rate: 0.08 }))).toBe("Looked at all 142 of your emails: 8% got a reply");
    expect(narrate("read_evidence", {}, evidence({ filter: {}, groupBy: "inbox_type" }, { n: 142, rate: 0.08 }))).toBe("Compared your emails by type of inbox");
    expect(narrate("read_evidence", {}, evidence({ filter: { inbox_type: "careers_inbox" } }, { n: 51, rate: 0.098 }))).toBe("Looked at 51 emails to careers@ inboxes: 10% got a reply");
    expect(narrate("read_rulebook", {}, JSON.stringify({ rules: [1, 2, 3, 4, 5] }))).toBe("Read your 5 rules");
    expect(narrate("propose_rule_change", { op: "modify", rule_id: "R-002", title: "Prefer careers@ inboxes" }, "Stored P-021 (pending human review).")).toBe('Suggested for Rule 2: "Prefer careers@ inboxes"');
    expect(narrate("propose_rule_change", { op: "modify", rule_id: "R-002" }, "error: n must be 51", true)).toMatch(/dropped$/);
    expect(narrate("submit_critique", { verdict: "oppose", adjusted_confidence: 0.4 }, "Recorded oppose for P-020.")).toBe("Disagrees, 40% sure");
  });

  it("merges repeated lines", () => {
    const out = collapse([{ agent: "a", text: "x" }, { agent: "a", text: "x" }, { agent: "b", text: "x" }]);
    expect(out.map((s) => [s.agent, s.times])).toEqual([["a", 2], ["b", 1]]);
  });
});
