// Pre-flight check: "Should I send this?" The matching slice and its numbers are computed here, in code.
// The model only words the verdict; checkVerdict() rejects any answer whose numbers or rule IDs don't match.
import { z } from "zod";
import { filterEvidence, isSend, stats, type Evidence, type Filter } from "./evidence";

/** The operator's country. "Same country as me" means this market. */
export const homeMarket = () => process.env.RULEBOOK_HOME_MARKET || "IN";

export const PreflightFormSchema = z
  .object({
    location: z.enum(["home", "abroad"]),
    company: z.enum(["startup", "scaleup", "enterprise", "agency", "other"]),
    who: z.enum(["recruiter", "hiring_manager", "founder", "careers_inbox"]),
    address: z.enum(["published", "guessed"]),
  })
  .strict();
export type PreflightForm = z.infer<typeof PreflightFormSchema>;
type Field = keyof PreflightForm;

/** What the AI may read out of a pasted job post: any of the four answers it can tell, plus the role. */
export const JobPostAnswersSchema = z
  .object({
    location: PreflightFormSchema.shape.location.nullable(),
    company: PreflightFormSchema.shape.company.nullable(),
    who: PreflightFormSchema.shape.who.nullable(),
    address: PreflightFormSchema.shape.address.nullable(),
    role: z.string().min(2).max(80).describe("The job title, e.g. Senior Full-Stack Engineer."),
    company_name: z.string().min(1).max(80).nullable().describe("The company's name, if the post says it."),
  })
  .strict();
export type JobPostAnswers = z.infer<typeof JobPostAnswersSchema>;

/** Max length of a pasted job post sent to the model. */
export const MAX_JOB_POST = 6000;

const MARKET_NAMES: Record<string, string> = { IN: "India", UK: "the UK", US: "the US", DE: "Germany", NL: "the Netherlands" };
export const homeCountry = () => MARKET_NAMES[homeMarket()] ?? homeMarket();

/** Below this many similar emails we loosen the match, and never suggest anything. */
export const MIN_SIMILAR = 5;

/** Loosen in this order; how the address was found goes last because it matters most (guessed addresses bounce). */
export const RELAX_ORDER: Field[] = ["company", "who", "location", "address"];

/**
 * Plain answers → evidence filters. The data can't tell a named recruiter from a hiring manager
 * (both are `named_person`), so "recruiter" means the recruiting team's inbox (hr@).
 */
function filterFor(field: Field, form: PreflightForm): Filter {
  const home = homeMarket();
  switch (field) {
    case "location":
      return { market: form.location === "home" ? home : { not: home } };
    case "company":
      return form.company === "other" ? {} : { company_stage: { startup: "startup", scaleup: "scaleup", enterprise: "enterprise", agency: "agency_services" }[form.company] };
    case "who":
      return {
        inbox_type: {
          recruiter: ["hr_inbox", "inbound_recruiter"],
          hiring_manager: ["named_person"],
          founder: ["founders_alias", "named_person"],
          careers_inbox: ["careers_inbox", "generic_inbox", "ats_portal"],
        }[form.who],
      };
    case "address":
      return { address_pattern: form.address === "published" ? "role" : ["first", "first.last", "other"] };
  }
}

const WHO: Record<PreflightForm["who"], string> = { recruiter: "recruiters", hiring_manager: "hiring managers", founder: "founders", careers_inbox: "careers inboxes" };
const COMPANY: Record<PreflightForm["company"], string> = { startup: "startups", scaleup: "scale-ups", enterprise: "enterprises", agency: "agencies", other: "companies" };

/** "guessed addresses of hiring managers at startups abroad", leaving out the loosened fields. */
export function sliceLabel(form: PreflightForm, used: Field[]): string {
  const has = (f: Field) => used.includes(f);
  const addr = has("address") ? (form.address === "guessed" ? "guessed addresses" : "published addresses") : "";
  const who = has("who") ? WHO[form.who] : "";
  const parts = [
    addr && who ? `${addr} of ${who}` : addr || who || "emails",
    `at ${has("company") && form.company !== "other" ? COMPANY[form.company] : "any company"}`,
    has("location") ? (form.location === "home" ? "in your country" : "abroad") : "",
  ];
  return parts.filter(Boolean).join(" ");
}

export interface PreflightSlice {
  label: string;
  n: number;
  replies: number;
  bounces: number;
  evidence_ids: string[];
  /** The filter actually used (for "Turn this into a rule"). */
  filter: Filter;
  /** Fields left out to reach MIN_SIMILAR emails, in RELAX_ORDER. */
  relaxed: Field[];
}

/** Your similar past emails: the exact match, or the closest one with at least MIN_SIMILAR sends. */
export function computeSlice(rows: Evidence[], form: PreflightForm): PreflightSlice {
  const sends = rows.filter(isSend);
  let used = [...RELAX_ORDER];
  let best: PreflightSlice | undefined;
  for (let i = 0; i <= RELAX_ORDER.length; i++) {
    used = RELAX_ORDER.slice(i);
    const filter = Object.assign({}, ...used.map((f) => filterFor(f, form))) as Filter;
    const match = filterEvidence(sends, filter);
    const s = stats(match);
    best = { label: sliceLabel(form, used), n: s.n, replies: s.humanReplies, bounces: s.bounces, evidence_ids: match.map((r) => r.id), filter, relaxed: RELAX_ORDER.slice(0, i) };
    if (s.n >= MIN_SIMILAR || i === RELAX_ORDER.length - 1) break; // never loosen to "all emails"
  }
  return best!;
}

export const VerdictSchema = z
  .object({
    verdict: z.enum(["go", "change", "skip", "no_rule"]),
    headline: z.string().min(3).max(160).describe("One short sentence."),
    rule_ids: z.array(z.string().regex(/^R-\d{3,}$/)).max(6).describe("Rules behind the verdict. [] when verdict is no_rule."),
    slice: z
      .object({ label: z.string(), n: z.number().int(), replies: z.number().int(), bounces: z.number().int(), evidence_ids: z.array(z.string()) })
      .strict()
      .describe("Copy these values exactly from the slice you were given."),
    do_instead: z.string().min(5).max(240).nullable().describe("One concrete action, or null."),
    basis: z.enum(["rule", "evidence_only"]),
  })
  .strict();
export type Verdict = z.infer<typeof VerdictSchema>;

/** Why a model answer can't be shown, or null when it's consistent with the server's numbers and rules. */
export function checkVerdict(v: Verdict, slice: PreflightSlice, ruleIds: string[]): string | null {
  if (v.slice.n !== slice.n || v.slice.replies !== slice.replies || v.slice.bounces !== slice.bounces || v.slice.label !== slice.label) {
    return `slice must be copied exactly: label "${slice.label}", n=${slice.n}, replies=${slice.replies}, bounces=${slice.bounces}`;
  }
  const known = new Set(slice.evidence_ids);
  const strange = v.slice.evidence_ids.filter((id) => !known.has(id));
  if (strange.length) return `evidence_ids not in the slice: ${strange.join(", ")}`;
  const unknown = v.rule_ids.filter((id) => !ruleIds.includes(id));
  if (unknown.length) return `rule_ids not in RULES.md: ${unknown.join(", ")}`;
  if (v.verdict === "no_rule" && (v.rule_ids.length || v.basis !== "evidence_only")) return 'no_rule means rule_ids [] and basis "evidence_only"';
  if (v.verdict !== "no_rule" && (!v.rule_ids.length || v.basis !== "rule")) return 'go, change and skip must cite at least one rule, with basis "rule"';
  return null;
}

/** The answer the UI shows: server numbers and evidence, and no suggestion when there's too little to go on. */
export function finalVerdict(v: Verdict, slice: PreflightSlice): Verdict & { tooFew: boolean; relaxed: string[] } {
  const tooFew = v.verdict === "no_rule" && slice.n < MIN_SIMILAR;
  return {
    ...v,
    slice: { label: slice.label, n: slice.n, replies: slice.replies, bounces: slice.bounces, evidence_ids: slice.evidence_ids },
    do_instead: tooFew ? null : v.do_instead,
    tooFew,
    relaxed: slice.relaxed,
  };
}

export const EmailDraftSchema = z
  .object({
    to: z.string().min(2).max(120).describe('Which address to use, e.g. "their published careers@ inbox". Never a guessed address unless the rules allow it.'),
    subject: z.string().min(3).max(140),
    body: z.string().min(40).max(2500).describe("The email, using <company> and <person> where names go, signed <candidate>."),
    notes: z
      .array(
        z
          .object({
            text: z.string().min(3).max(160).describe('Why one choice was made, e.g. "Short opening, like your email that got an interested reply".'),
            rule_id: z.string().regex(/^R-\d{3,}$/).nullable(),
            example_id: z.string().nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(5),
  })
  .strict();
export type EmailDraft = z.infer<typeof EmailDraftSchema>;

/** Why a drafted email can't be shown: notes may cite only real rules and the example emails it was given. */
export function checkEmail(d: EmailDraft, ruleIds: string[], exampleIds: string[]): string | null {
  const badRule = d.notes.map((n) => n.rule_id).filter((id) => id && !ruleIds.includes(id));
  if (badRule.length) return `rule_id not in RULES.md: ${badRule.join(", ")}`;
  const badExample = d.notes.map((n) => n.example_id).filter((id) => id && !exampleIds.includes(id));
  if (badExample.length) return `example_id not among the examples you were given: ${badExample.join(", ")}`;
  return null;
}
