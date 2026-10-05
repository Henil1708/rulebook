// read_rulebook and propose_rule_change. Proposing never touches git: it validates and stores a pending proposal.
import { tool } from "@open-gitagent/gitagent";
import { z } from "zod";
import { FilterSchema, sliceStats, type Evidence } from "../evidence";
import { applyProposal, cleanRuleText, nextRuleId, parseRules, RULE_ID, type Rule } from "../rules";
import type { Proposal, ProposalStore } from "../store/proposals";
import { parseArgs, toolSchema } from "./schema";

export const ProposalInputSchema = z
  .object({
    op: z.enum(["add", "modify", "retire"]),
    rule_id: z.string().regex(RULE_ID).optional().describe("Required for modify and retire. Omit for add (the ID is assigned on accept)."),
    rule_text: z.string().min(10).max(300).optional().describe("The NEW rule as one sentence (for modify it must differ from the current text). Required for add and modify. No ID prefix."),
    evidence_ids: z.array(z.string().regex(/^(ev|syn)-[\w-]+$/)).min(1).max(40).describe("IDs of rows inside the slice (from read_evidence with this slice's filter)."),
    slice: FilterSchema,
    n: z.number().int().min(0).describe("stats.n from read_evidence with this slice's filter."),
    metric: z.string().min(3).max(200).describe('The outcome difference, e.g. "0 human replies, 4 bounces out of 34".'),
    rationale: z.string().min(10).max(800),
    confidence: z.number().min(0).max(1),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.op !== "add" && !p.rule_id) ctx.addIssue({ code: "custom", path: ["rule_id"], message: `required for ${p.op}` });
    if (p.op === "add" && p.rule_id) ctx.addIssue({ code: "custom", path: ["rule_id"], message: "omit for add" });
    if (p.op !== "retire" && !p.rule_text) ctx.addIssue({ code: "custom", path: ["rule_text"], message: `required for ${p.op}` });
  });

export type ProposalInput = z.infer<typeof ProposalInputSchema>;

export function readRulebookTool(readRules: () => string) {
  return tool(
    "read_rulebook",
    "Read the current outreach rulebook (RULES.md) as a list of {id, text}.",
    toolSchema(z.object({}).strict()),
    async () => JSON.stringify({ rules: parseRules(readRules()) satisfies Rule[] }),
  );
}

export interface ProposeContext {
  runId: string;
  rows: Evidence[]; // the evidence this run may see
  readRules: () => string;
  store: ProposalStore;
  maxPerRun: number;
}

/** Validate a proposal against the schema, the rulebook and the evidence, then store it as pending. */
export function propose(ctx: ProposeContext, args: unknown): Proposal {
  const input = parseArgs(ProposalInputSchema, args);
  const made = ctx.store.list().filter((p) => p.run_id === ctx.runId).length;
  if (made >= ctx.maxPerRun) throw new Error(`limit reached: at most ${ctx.maxPerRun} proposals per run`);

  // Must apply cleanly to the current rulebook (rule exists for modify/retire, text is valid for add).
  const rules = ctx.readRules();
  applyProposal(rules, input, nextRuleId(parseRules(rules).map((r) => r.id)));
  if (input.op === "modify") {
    const current = parseRules(rules).find((r) => r.id === input.rule_id)!.text;
    if (cleanRuleText(input.rule_text!) === current) throw new Error(`rule_text is identical to the current ${input.rule_id}; write the new rule`);
  }

  const known = new Set(ctx.rows.map((r) => r.id));
  const unknown = input.evidence_ids.filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`unknown evidence IDs (not in this run's evidence): ${unknown.join(", ")}`);

  // The claim must match the slice it names: same n, and every cited row inside it.
  const s = sliceStats(ctx.rows, input.slice);
  const inSlice = new Set(s.rows.map((r) => r.id));
  const outside = input.evidence_ids.filter((id) => !inSlice.has(id));
  if (outside.length) throw new Error(`evidence IDs not in this slice: ${outside.join(", ")}. Cite IDs from read_evidence with this slice's filter`);
  if (input.n !== s.n) throw new Error(`n must be the sends in this slice: ${s.n}, not ${input.n}`);

  return ctx.store.add({
    run_id: ctx.runId,
    ...input,
    evidence_ids: [...new Set(input.evidence_ids)],
    check: { n: s.n, humanReplies: s.humanReplies, bounces: s.bounces },
  });
}

export function proposeRuleChangeTool(ctx: ProposeContext) {
  return tool(
    "propose_rule_change",
    `Propose ONE change to the rulebook for a human to review. Cite evidence IDs; n must be the sends in the slice. At most ${ctx.maxPerRun} per run.`,
    toolSchema(ProposalInputSchema),
    async (args: unknown) => `Stored ${propose(ctx, args).id} (pending human review).`,
  );
}
