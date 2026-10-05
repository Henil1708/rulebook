import { describe, expect, it } from "vitest";
import { loadEvidence } from "../evidence";
import { MAX_SAMPLE, readEvidence, readEvidenceTool } from "./readEvidence";

const real = loadEvidence();

describe("readEvidence", () => {
  it("returns aggregates and at most 15 compact sample rows with IDs", () => {
    const out = readEvidence(real);
    expect(out.stats).toMatchObject({ n: 137, humanReplies: 11, bounces: 11, rate: 0.08 });
    expect(out.sample).toHaveLength(MAX_SAMPLE);
    expect(out.omittedRows).toBe(137 - MAX_SAMPLE);
    for (const row of out.sample) {
      expect(row.id).toMatch(/^ev-\d{3}$/);
      expect(row).not.toHaveProperty("recipient");
      expect(row).not.toHaveProperty("subject");
    }
  });

  it("puts the signal rows (replies, then bounces) first so they can be cited", () => {
    const out = readEvidence(real);
    const outcomes = out.sample.map((r) => r.outcome);
    expect(outcomes.slice(0, 11).every((o) => o.startsWith("reply_"))).toBe(true);
    expect(outcomes.slice(11, 15).every((o) => o === "bounce")).toBe(true);
  });

  it("returns every row when the slice is small", () => {
    const out = readEvidence(real, { filter: { company_stage: "enterprise", segment: "ai_product" } });
    expect(out.sample).toHaveLength(out.stats.n);
    expect(out.omittedRows).toBe(0);
  });

  it("the foreign named_person slice: 34 sends, 0 replies, 4 bounces, bounces first", () => {
    const out = readEvidence(real, { filter: { market: { not: "IN" }, inbox_type: "named_person" } });
    expect(out.stats).toMatchObject({ n: 34, humanReplies: 0, bounces: 4, rate: 0 });
    expect(out.sample.slice(0, 4).every((r) => r.outcome === "bounce")).toBe(true);
  });

  it("groupBy returns per-group stats, largest first", () => {
    const out = readEvidence(real, { groupBy: "company_stage" });
    const byKey = Object.fromEntries(out.groups!.map((g) => [g.key, g]));
    expect(byKey.agency_services).toMatchObject({ n: 46, humanReplies: 1, bounces: 5 });
    expect(byKey.scaleup).toMatchObject({ n: 37, humanReplies: 6, bounces: 6 });
    expect(out.groups!.reduce((s, g) => s + g.n, 0)).toBe(137);
    expect(out.groups!.map((g) => g.n)).toEqual([...out.groups!.map((g) => g.n)].sort((a, b) => b - a));
  });

  it("stays small: the whole-dataset answer is a few KB, not the file", () => {
    expect(JSON.stringify(readEvidence(real, { groupBy: "market" })).length).toBeLessThan(6000);
  });

  it("rejects an unknown groupBy", () => {
    expect(() => readEvidence(real, { groupBy: "country" as never })).toThrow(/unknown groupBy/);
  });
});

describe("read_evidence tool", () => {
  it("is a gitagent tool whose handler returns the JSON result", async () => {
    const t = readEvidenceTool(() => real);
    expect(t.name).toBe("read_evidence");
    const res = JSON.parse((await t.handler({ filter: { duplicate_of_earlier: "true" } })) as string);
    expect(res.stats).toMatchObject({ n: 30, humanReplies: 3, bounces: 3 });
  });

  it("reads rows per call, so the synthetic toggle applies immediately", async () => {
    let synthetic = false;
    const t = readEvidenceTool(() => loadEvidence({ synthetic }));
    const n = async () => JSON.parse((await t.handler({})) as string).stats.n;
    const before = await n();
    synthetic = true;
    expect(await n()).toBeGreaterThan(before);
  });
});
