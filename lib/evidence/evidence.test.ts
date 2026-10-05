import { describe, expect, it } from "vitest";
import { filterEvidence, isSend, loadEvidence, sliceStats, type Filter } from ".";

const real = loadEvidence();
const all = loadEvidence({ synthetic: true });

describe("loadEvidence", () => {
  it("loads 142 real rows, plus 45 synthetic only when asked", () => {
    expect(real).toHaveLength(142);
    expect(new Set(real.map((r) => r.source))).toEqual(new Set(["gmail"]));
    expect(all).toHaveLength(187);
    expect(all.filter((r) => r.source === "synthetic")).toHaveLength(45);
  });
});

describe("sliceStats reproduces data/README.md", () => {
  it("baseline: 137 sends, 11 human replies (8%), 11 bounces", () => {
    const s = sliceStats(real);
    expect([s.n, s.humanReplies, s.bounces]).toEqual([137, 11, 11]);
    expect(Math.round(s.rate * 100)).toBe(8);
  });

  it("excludes exactly the 3 pending rows, the undated ATS row and the inbound recruiter", () => {
    const excluded = real.filter((r) => !isSend(r)).map((r) => r.id).sort();
    expect(excluded).toEqual(["ev-001", "ev-137", "ev-138", "ev-140", "ev-141"]);
  });

  const table: [string, Filter, number, number, number][] = [
    ["guessed personal address at a foreign company", { market: { not: "IN" }, inbox_type: "named_person" }, 34, 0, 4],
    ["agency / IT-services companies", { company_stage: "agency_services" }, 46, 1, 5],
    ["enterprises", { company_stage: "enterprise" }, 17, 0, 0],
    ["AI-product companies", { segment: "ai_product" }, 19, 4, 0],
    ["scale-ups", { company_stage: "scaleup" }, 37, 6, 6],
    ["re-sent to an address already emailed", { duplicate_of_earlier: true }, 30, 3, 3],
  ];

  it.each(table)("%s → n=%i, %i human replies, %i bounces", (_, filter, n, replies, bounces) => {
    const s = sliceStats(real, filter);
    expect({ n: s.n, humanReplies: s.humanReplies, bounces: s.bounces }).toEqual({ n, humanReplies: replies, bounces });
    expect(s.rows).toHaveLength(n);
  });

  it("README percentages: AI-product 21%, scale-ups 16%, re-sends 10%, agencies 2%", () => {
    const pct = (f: Filter) => Math.round(sliceStats(real, f).rate * 100);
    expect(pct({ segment: "ai_product" })).toBe(21);
    expect(pct({ company_stage: "scaleup" })).toBe(16);
    expect(pct({ duplicate_of_earlier: true })).toBe(10);
    expect(pct({ company_stage: "agency_services" })).toBe(2);
  });

  it("89 emails went out on 12 Jul", () => {
    expect(filterEvidence(real, {}, { from: "2026-07-12", to: "2026-07-12" })).toHaveLength(89);
  });

  it("splits human replies into positive / rejections / redirects", () => {
    const s = sliceStats(real);
    expect(s.positive + s.rejections).toBeLessThanOrEqual(s.humanReplies);
    expect(s.humanReplies - s.positive - s.rejections).toBe(2); // the two reply_redirect rows
  });
});

describe("filterEvidence", () => {
  it("lists match any value; not excludes", () => {
    const either = filterEvidence(real, { company_stage: ["enterprise", "scaleup"] });
    expect(either.every((r) => ["enterprise", "scaleup"].includes(r.company_stage))).toBe(true);
    expect(filterEvidence(real, { market: { not: ["IN", "UK"] } }).some((r) => ["IN", "UK"].includes(r.market))).toBe(false);
  });

  it("matches booleans given as strings (tool callers send JSON)", () => {
    expect(filterEvidence(real, { duplicate_of_earlier: "true" })).toEqual(filterEvidence(real, { duplicate_of_earlier: true }));
  });

  it("window is inclusive and drops undated rows", () => {
    const w = filterEvidence(real, {}, { from: "2026-06-01", to: "2026-12-31" });
    expect(w).toHaveLength(141);
    expect(w.some((r) => r.id === "ev-001")).toBe(false);
  });

  it("synthetic rows only appear when loaded, and syn-trap is the one lucky reply in its slice", () => {
    expect(sliceStats(real, { source: "synthetic" }).n).toBe(0);
    const trap = sliceStats(all, { source: "synthetic", company_stage: "enterprise", inbox_type: "generic_inbox" });
    expect(trap.n).toBe(5);
    expect(trap.humanReplies).toBe(1);
    expect(trap.rows.filter((r) => r.outcome.startsWith("reply_")).map((r) => r.id)).toEqual(["syn-trap"]);
  });

  it("rejects unknown fields and bad dates instead of returning an empty slice", () => {
    expect(() => filterEvidence(real, { country: "DE" } as Filter)).toThrow(/unknown filter field "country"/);
    expect(() => filterEvidence(real, {}, { from: "12 Jul" })).toThrow(/YYYY-MM-DD/);
  });
});
