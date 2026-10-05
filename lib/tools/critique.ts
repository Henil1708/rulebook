// submit_critique: the Skeptic's only output. Bound to one proposal; code enforces the sample-size rule.
import { tool } from "@open-gitagent/gitagent";
import { z } from "zod";
import type { Critique, ProposalStore, Verdict } from "../store/proposals";
import { parseArgs, toolSchema } from "./schema";

/** Below this many sends a slice is a hypothesis, not a lesson (data/README.md, Skeptic RULES.md). */
export const MIN_N_FOR_SUPPORT = 10;

export const CritiqueInputSchema = z
  .object({
    verdict: z.enum(["support", "caution", "oppose"]),
    adjusted_confidence: z.number().min(0).max(1),
    concerns: z.array(z.string().min(3).max(300)).min(1).max(8).describe("Specific issues: small n, confounders, duplicates, synthetic rows, rejections counted as replies."),
    what_would_change_my_mind: z.string().min(10).max(500),
  })
  .strict();

export type CritiqueInput = z.infer<typeof CritiqueInputSchema>;

/** The model's verdict, unless code must override it. `n` is the server-checked slice size. */
export function enforcePolicy(input: CritiqueInput, n: number): Pick<Critique, "verdict" | "override"> {
  if (input.verdict === "support" && n < MIN_N_FOR_SUPPORT) {
    const verdict: Verdict = "caution";
    return { verdict, override: { model_verdict: "support", reason: `n=${n} is below ${MIN_N_FOR_SUPPORT}: support is not allowed, downgraded to caution` } };
  }
  return { verdict: input.verdict };
}

export interface CritiqueContext {
  proposalId: string;
  runId: string;
  store: ProposalStore;
}

export function submitCritique(ctx: CritiqueContext, args: unknown): Critique {
  const input = parseArgs(CritiqueInputSchema, args);
  const p = ctx.store.get(ctx.proposalId);
  if (!p) throw new Error(`${ctx.proposalId} not found`);
  if (p.critique?.run_id === ctx.runId) throw new Error("critique already submitted for this proposal in this run");

  const critique: Critique = {
    run_id: ctx.runId,
    at: new Date().toISOString(),
    ...input,
    ...enforcePolicy(input, p.check.n),
  };
  ctx.store.update(ctx.proposalId, { critique, critique_error: undefined });
  return critique;
}

export function submitCritiqueTool(ctx: CritiqueContext) {
  return tool(
    "submit_critique",
    `Submit your critique of proposal ${ctx.proposalId}. Call exactly once.`,
    toolSchema(CritiqueInputSchema),
    async (args: unknown) => {
      const c = submitCritique(ctx, args);
      return c.override
        ? `Recorded ${c.verdict} for ${ctx.proposalId}. Your verdict "${c.override.model_verdict}" was overridden: ${c.override.reason}.`
        : `Recorded ${c.verdict} for ${ctx.proposalId}.`;
    },
  );
}
