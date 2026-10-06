import { describe, expect, it } from "vitest";
import { loadEvidence } from "./evidence";
import { checkEmail, checkVerdict, computeSlice, finalVerdict, RELAX_ORDER, type PreflightForm, type Verdict } from "./preflight";

const rows = loadEvidence();
const form = (over: Partial<PreflightForm> = {}): PreflightForm => ({ location: "abroad", company: "startup", who: "hiring_manager", address: "guessed", ...over });

describe("computeSlice", () => {
  it("counts the exact match in code when there are enough similar emails", () => {
    const s = computeSlice(rows, form());
    expect(s).toMatchObject({ label: "guessed addresses of hiring managers at startups abroad", n: 15, replies: 0, bounces: 0, relaxed: [] });
    expect(s.evidence_ids).toHaveLength(15);
  });

  it("loosens one field at a time, company type first and the address source last, and says which slice was used", () => {
    expect(RELAX_ORDER).toEqual(["company", "who", "location", "address"]);
    const agency = computeSlice(rows, form({ company: "agency" }));
    expect(agency).toMatchObject({ relaxed: ["company"], label: "guessed addresses of hiring managers at any company abroad", n: 34, bounces: 4 });
    const recruiter = computeSlice(rows, form({ company: "other", who: "recruiter", address: "published" }));
    expect(recruiter).toMatchObject({ relaxed: ["company", "who"], label: "published addresses at any company abroad", n: 10 });
  });

  it("never loosens the address source away", () => {
    const s = computeSlice(rows, form({ location: "home", company: "enterprise", who: "founder" }));
    expect(s.relaxed).not.toContain("address");
    expect(s.filter).toHaveProperty("address_pattern");
  });
});

const slice = computeSlice(rows, form());
const answer = (over: Partial<Verdict> = {}): Verdict => ({
  verdict: "skip",
  headline: "Don't guess personal addresses abroad.",
  rule_ids: ["R-003"],
  slice: { label: slice.label, n: slice.n, replies: slice.replies, bounces: slice.bounces, evidence_ids: slice.evidence_ids.slice(0, 3) },
  do_instead: "Use the careers@ inbox.",
  basis: "rule",
  ...over,
});

describe("checkVerdict", () => {
  it("accepts an answer that copies the server's numbers and cites real rules", () => {
    expect(checkVerdict(answer(), slice, ["R-001", "R-003"])).toBeNull();
  });

  it("rejects numbers that differ from the server's slice", () => {
    expect(checkVerdict(answer({ slice: { ...answer().slice, replies: 2 } }), slice, ["R-003"])).toMatch(/copied exactly/);
    expect(checkVerdict(answer({ slice: { ...answer().slice, evidence_ids: ["ev-999"] } }), slice, ["R-003"])).toMatch(/not in the slice/);
  });

  it("rejects rule IDs that aren't in RULES.md", () => {
    expect(checkVerdict(answer({ rule_ids: ["R-042"] }), slice, ["R-003"])).toMatch(/not in RULES.md: R-042/);
  });

  it("keeps no_rule honest: no rules cited, evidence only", () => {
    expect(checkVerdict(answer({ verdict: "no_rule" }), slice, ["R-003"])).toMatch(/no_rule/);
    expect(checkVerdict(answer({ verdict: "no_rule", rule_ids: [], basis: "evidence_only" }), slice, ["R-003"])).toBeNull();
  });
});

describe("finalVerdict", () => {
  const noRule = answer({ verdict: "no_rule", rule_ids: [], basis: "evidence_only", do_instead: "Find a published careers@ address first." });

  it("no_rule with 5+ similar emails keeps the suggestion", () => {
    expect(finalVerdict(noRule, slice)).toMatchObject({ tooFew: false, do_instead: "Find a published careers@ address first." });
  });

  it("no_rule with fewer than 5 similar emails drops it: too few to suggest anything", () => {
    const small = { ...slice, n: 3, evidence_ids: slice.evidence_ids.slice(0, 3) };
    expect(finalVerdict(noRule, small)).toMatchObject({ tooFew: true, do_instead: null });
  });

  it("always shows the server's numbers and full evidence list", () => {
    expect(finalVerdict(answer(), slice).slice.evidence_ids).toHaveLength(15);
  });
});

describe("checkEmail", () => {
  const email = (notes: { text: string; rule_id: string | null; example_id: string | null }[]) => ({ to: "careers@", subject: "Senior engineer", body: "x".repeat(50), notes });

  it("lets notes point only at real rules and at the past emails the writer was shown", () => {
    expect(checkEmail(email([{ text: "Published inbox", rule_id: "R-003", example_id: "ev-010" }]), ["R-003"], ["ev-010"])).toBeNull();
    expect(checkEmail(email([{ text: "x", rule_id: "R-042", example_id: null }]), ["R-003"], [])).toMatch(/R-042/);
    expect(checkEmail(email([{ text: "x", rule_id: null, example_id: "ev-999" }]), ["R-003"], ["ev-010"])).toMatch(/ev-999/);
  });
});
