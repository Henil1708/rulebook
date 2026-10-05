import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { proposalStore, type NewProposal, type ProposalStore } from "../store/proposals";
import { enforcePolicy, MIN_N_FOR_SUPPORT, submitCritique, submitCritiqueTool, type CritiqueInput } from "./critique";

const input = (over: Partial<CritiqueInput> = {}): CritiqueInput => ({
  verdict: "support",
  adjusted_confidence: 0.7,
  concerns: ["Slice is dominated by one send day (12 Jul)."],
  what_would_change_my_mind: "Ten more sends in this slice with the same outcome.",
  ...over,
});

describe("enforcePolicy: n < 10 ⇒ verdict ≠ support", () => {
  it("is 10, the README's threshold", () => expect(MIN_N_FOR_SUPPORT).toBe(10));

  it.each([0, 1, 4, 9])("downgrades support to caution at n=%i and says why", (n) => {
    expect(enforcePolicy(input(), n)).toEqual({
      verdict: "caution",
      override: { model_verdict: "support", reason: `n=${n} is below 10: support is not allowed, downgraded to caution` },
    });
  });

  it.each([10, 34, 137])("keeps support at n=%i", (n) => {
    expect(enforcePolicy(input(), n)).toEqual({ verdict: "support" });
  });

  it.each([
    ["caution", 3],
    ["oppose", 3],
    ["caution", 50],
    ["oppose", 50],
  ] as const)("never touches %s (n=%i)", (verdict, n) => {
    expect(enforcePolicy(input({ verdict }), n)).toEqual({ verdict });
  });
});

describe("submitCritique", () => {
  let dir: string;
  let store: ProposalStore;
  const proposal = (n: number): NewProposal => ({
    run_id: "a1",
    op: "add",
    rule_text: "Prefer careers inboxes at scale-ups.",
    evidence_ids: ["ev-010"],
    slice: { company_stage: "scaleup" },
    n,
    metric: "x",
    rationale: "because",
    confidence: 0.8,
    check: { n, humanReplies: 1, bounces: 0 },
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rulebook-critique-"));
    store = proposalStore(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("stores the critique on the proposal", () => {
    const id = store.add(proposal(34)).id;
    const c = submitCritique({ proposalId: id, runId: "s1", store }, input());
    expect(c).toMatchObject({ run_id: "s1", verdict: "support", adjusted_confidence: 0.7 });
    expect(c).not.toHaveProperty("override");
    expect(store.get(id)?.critique).toEqual(c);
  });

  it("uses the server-checked n, not the Analyst's claimed n", () => {
    const id = store.add({ ...proposal(4), n: 40 }).id; // Analyst claimed 40; the slice really has 4
    expect(submitCritique({ proposalId: id, runId: "s1", store }, input()).override?.model_verdict).toBe("support");
  });

  it("records the override where the operator will see it, and tells the model", async () => {
    const id = store.add(proposal(6)).id;
    const tool = submitCritiqueTool({ proposalId: id, runId: "s1", store });
    expect(await tool.handler(input())).toBe(
      `Recorded caution for ${id}. Your verdict "support" was overridden: n=6 is below 10: support is not allowed, downgraded to caution.`,
    );
    expect(store.get(id)?.critique).toMatchObject({ verdict: "caution", override: { model_verdict: "support" } });
  });

  it("is bound to one proposal and accepts one critique per Skeptic run", () => {
    const id = store.add(proposal(34)).id;
    const ctx = { proposalId: id, runId: "s1", store };
    submitCritique(ctx, input());
    expect(() => submitCritique(ctx, input({ verdict: "oppose" }))).toThrow(/already submitted/);
    expect(submitCritique({ ...ctx, runId: "s2" }, input({ verdict: "oppose" })).verdict).toBe("oppose"); // a re-run replaces it
    expect(() => submitCritique({ ...ctx, proposalId: "P-404" }, input())).toThrow(/P-404 not found/);
  });

  it.each([
    ["unknown verdict", { verdict: "approve" }],
    ["confidence > 1", { adjusted_confidence: 1.2 }],
    ["no concerns", { concerns: [] }],
    ["extra field", { proposal_id: "P-002" }],
  ])("rejects %s", (_, over) => {
    const id = store.add(proposal(34)).id;
    expect(() => submitCritique({ proposalId: id, runId: "s1", store }, { ...input(), ...over })).toThrow();
    expect(store.get(id)?.critique).toBeUndefined();
  });
});
