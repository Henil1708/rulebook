// submit_draft: the Drafter's only output. Cited rule IDs must exist in the rulebook it was given.
import { tool } from "@open-gitagent/gitagent";
import { z } from "zod";
import { RULE_ID } from "../rules";
import { parseArgs, toolSchema } from "./schema";

export const DraftInputSchema = z
  .object({
    decision: z.enum(["draft", "skip"]).describe('"skip" when a rule says not to contact this target.'),
    to: z.string().min(2).max(120).optional().describe("Which address or inbox to send to, e.g. careers@ (never a guessed personal address unless a rule allows it)."),
    subject: z.string().min(3).max(120).optional(),
    body: z.string().min(20).max(2000).optional().describe('The email. Cite the rule behind a choice inline, e.g. "(R-004)".'),
    reason: z.string().min(5).max(400).optional().describe("For skip: which rule made you skip, and why."),
    cited_rules: z.array(z.string().regex(RULE_ID)).max(10).describe("Every rule ID that shaped the draft or the skip."),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.decision === "draft" && (!d.to || !d.subject || !d.body)) ctx.addIssue({ code: "custom", path: ["body"], message: "a draft needs to, subject and body" });
    if (d.decision === "skip" && !d.reason) ctx.addIssue({ code: "custom", path: ["reason"], message: "a skip needs a reason" });
  });

export type DraftInput = z.infer<typeof DraftInputSchema>;

export function submitDraftTool(ruleIds: string[], onDraft: (d: DraftInput) => void) {
  const known = new Set(ruleIds);
  return tool(
    "submit_draft",
    "Submit the email draft (or the decision to skip this target). Call exactly once.",
    toolSchema(DraftInputSchema),
    async (args: unknown) => {
      const parsed = parseArgs(DraftInputSchema, args);
      // Models sometimes double-escape line breaks ("\\n" in the text); turn them back into real ones.
      const d = { ...parsed, ...(parsed.body ? { body: parsed.body.replace(/\\n/g, "\n") } : {}) };
      const inline = [...(d.body ?? "").matchAll(/\((R-\d{3,})\)/g)].map((m) => m[1]);
      const unknown = [...new Set([...d.cited_rules, ...inline])].filter((id) => !known.has(id));
      if (unknown.length) throw new Error(`these rule IDs are not in your RULES.md: ${unknown.join(", ")}. Cite only: ${ruleIds.join(", ")}`);
      onDraft({ ...d, cited_rules: [...new Set([...d.cited_rules, ...inline])] });
      return "Draft recorded.";
    },
  );
}
