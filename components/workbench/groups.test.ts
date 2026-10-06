import { describe, expect, it } from "vitest";
import type { Proposal } from "@/lib/store/proposals";
import { groupByRule, titleOf } from "./groups";

const p = (id: string, over: Partial<Proposal> = {}): Proposal => ({
  id, status: "pending", created_at: "", run_id: "r", op: "modify", rule_id: "R-002", rule_text: "Send to the careers@ inbox first.",
  evidence_ids: [], slice: {}, n: 10, metric: "", rationale: "", confidence: 0.5, check: { n: 10, humanReplies: 1, bounces: 0 }, ...over,
});
const critique = (verdict: "support" | "caution" | "oppose", adjusted_confidence = 0.5) => ({ run_id: "", at: "", verdict, adjusted_confidence, concerns: [], what_would_change_my_mind: "" });

describe("groupByRule", () => {
  it("groups waiting suggestions by rule, strongest first, and puts all-opposed rules last", () => {
    const groups = groupByRule([
      p("P-1", { critique: critique("oppose") }),
      p("P-2", { critique: critique("caution", 0.4) }),
      p("P-3", { critique: critique("caution", 0.7) }),
      p("P-4", { rule_id: "R-001", critique: critique("oppose") }),
      p("P-5", { rule_id: "R-004" }),
      p("P-6", { op: "add", rule_id: undefined }),
      p("P-7", { status: "accepted" }),
    ]);
    expect(groups.map((g) => [g.key, g.suggestions.map((s) => s.id), g.against])).toEqual([
      ["R-002", ["P-3", "P-2", "P-1"], false],
      ["R-004", ["P-5"], false],
      ["P-6", ["P-6"], false],
      ["R-001", ["P-4"], true],
    ]);
  });

  it("names a suggestion by its title, else the start of its wording", () => {
    expect(titleOf(p("P-1", { title: "Prefer careers@" }))).toBe("Prefer careers@");
    expect(titleOf(p("P-1", { rule_text: "one two three four five six seven eight nine ten" }))).toBe("one two three four five six seven eight nine…");
    expect(titleOf(p("P-1", { op: "retire" }))).toBe("Remove this rule");
  });
});
