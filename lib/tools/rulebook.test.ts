import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { filterEvidence, loadEvidence } from "../evidence";
import { proposalStore, type ProposalStore } from "../store/proposals";
import { propose, ProposalInputSchema, proposeRuleChangeTool, readRulebookTool, type ProposeContext } from "./rulebook";
import { toolSchema } from "./schema";

const v0 = readFileSync("agent-template/RULES.md", "utf8");
const july = filterEvidence(loadEvidence(), {}, { from: "2026-07-12", to: "2026-07-31" });

let dir: string;
let store: ProposalStore;
let ctx: ProposeContext;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rulebook-store-"));
  store = proposalStore(dir);
  ctx = { runId: "run-1", rows: july, readRules: () => v0, store, maxPerRun: 3 };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const good = {
  op: "add",
  rule_text: "Do not guess personal email addresses at companies outside India.",
  evidence_ids: ["ev-056", "ev-057"],
  slice: { market: { not: "IN" }, inbox_type: "named_person" },
  n: 34,
  metric: "0 human replies, 4 bounces",
  rationale: "Guessed addresses abroad never got a human reply and some bounced.",
  confidence: 0.6,
};

describe("propose", () => {
  it("stores a valid proposal as pending with a server-side check of the slice", () => {
    const p = propose(ctx, good);
    expect(p).toMatchObject({ id: "P-001", status: "pending", run_id: "run-1", op: "add", n: 34 });
    expect(p.check.n).toBeGreaterThan(0);
    expect(store.list()).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, "proposals.json"), "utf8"))[0].id).toBe("P-001");
  });

  it("numbers proposals across runs", () => {
    propose(ctx, good);
    expect(propose({ ...ctx, runId: "run-2" }, good).id).toBe("P-002");
  });

  it("records the model's n next to the real n, and IDs that fall outside the slice", () => {
    const indian = july.find((r) => r.market === "IN")!.id; // in the window, not in the foreign slice
    const p = propose(ctx, { ...good, n: 999, evidence_ids: ["ev-056", indian] });
    expect(p.n).toBe(999);
    expect(p.check.n).not.toBe(999);
    expect(p.check.idsOutsideSlice).toEqual([indian]);
  });

  it.each([
    ["missing evidence", { ...good, evidence_ids: [] }, /evidence_ids/],
    ["unknown field", { ...good, extra: 1 }, /Unrecognized key/],
    ["bad op", { ...good, op: "delete" }, /op/],
    ["confidence out of range", { ...good, confidence: 1.5 }, /confidence/],
    ["add with rule_id", { ...good, rule_id: "R-009" }, /rule_id: omit for add/],
    ["modify without rule_id", { ...good, op: "modify" }, /rule_id: required for modify/],
    ["retire unknown rule", { ...good, op: "retire", rule_id: "R-042", rule_text: undefined }, /R-042 is not in the rulebook/],
    ["bad slice field", { ...good, slice: { country: "DE" } }, /slice/],
    ["bad evidence id format", { ...good, evidence_ids: ["drop table"] }, /evidence_ids/],
  ])("rejects %s", (_, args, err) => {
    expect(() => propose(ctx, args)).toThrow(err);
    expect(store.list()).toHaveLength(0);
  });

  it("rejects evidence IDs the run can't see (hallucinated or outside the window)", () => {
    expect(() => propose(ctx, { ...good, evidence_ids: ["ev-999"] })).toThrow(/unknown evidence IDs.*ev-999/);
    expect(() => propose(ctx, { ...good, evidence_ids: ["ev-142"] })).toThrow(/ev-142/); // sent in October
  });

  it("caps proposals per run", () => {
    for (let i = 0; i < 3; i++) propose(ctx, good);
    expect(() => propose(ctx, good)).toThrow(/at most 3 proposals per run/);
    expect(propose({ ...ctx, runId: "run-2" }, good).id).toBe("P-004");
  });

  it("allows retire without rule_text", () => {
    expect(propose(ctx, { ...good, op: "retire", rule_id: "R-003", rule_text: undefined }).op).toBe("retire");
  });
});

describe("tools", () => {
  it("propose_rule_change exposes a strict JSON schema and reports n mismatches to the model", async () => {
    const schema = toolSchema(ProposalInputSchema) as { additionalProperties: boolean; required: string[] };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(expect.arrayContaining(["op", "evidence_ids", "slice", "n", "metric", "rationale", "confidence"]));
    const t = proposeRuleChangeTool(ctx);
    expect(await t.handler({ ...good, n: 1 })).toMatch(/^Stored P-001 \(pending human review\)\. Note: the slice actually has n=\d+, not 1\.$/);
  });

  it("read_rulebook returns the parsed rules", async () => {
    const out = JSON.parse((await readRulebookTool(() => v0).handler({})) as string);
    expect(out.rules.map((r: { id: string }) => r.id)).toEqual(["R-001", "R-002", "R-003", "R-004", "R-005"]);
  });
});
