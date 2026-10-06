// runPreflight: "Should I send this?" Code computes the similar-emails slice; the root agent (the Drafter,
// which reads RULES.md) words a verdict through submit_verdict. Answers whose numbers or rule IDs don't
// match are rejected, and the model gets one retry with the reason.
import { tool } from "@open-gitagent/gitagent";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadEvidence } from "../evidence";
import { withLock } from "../git/GitService";
import { AGENT_DIR, STORE_DIR } from "../paths";
import {
  checkEmail,
  checkVerdict,
  computeSlice,
  EmailDraftSchema,
  finalVerdict,
  homeCountry,
  JobPostAnswersSchema,
  MAX_JOB_POST,
  MIN_SIMILAR,
  VerdictSchema,
  type EmailDraft,
  type JobPostAnswers,
  type PreflightForm,
  type Verdict,
} from "../preflight";
import { loadBodies, pickExamples, type Example } from "../email-examples";
import { ReviewError, RULES_PATH } from "../review";
import { parseRules } from "../rules";
import { proposalStore } from "../store/proposals";
import { runLog } from "../store/runs";
import { propose } from "../tools/rulebook";
import { parseArgs, toolSchema } from "../tools/schema";
import { runAgent } from "./run";
import { runSkeptic } from "./skeptic";

export type PreflightResult = ReturnType<typeof finalVerdict> & { costUsd: number };

export class PreflightError extends Error {}

export function runPreflight(form: PreflightForm, opts: { signal?: AbortSignal; jobPost?: string } = {}): Promise<PreflightResult> {
  return withLock(async () => {
    const slice = computeSlice(loadEvidence(), form);
    const rules = parseRules(readFileSync(join(AGENT_DIR, RULES_PATH), "utf8"));
    const ruleIds = rules.map((r) => r.id);
    const given = { label: slice.label, n: slice.n, replies: slice.replies, bounces: slice.bounces, evidence_ids: slice.evidence_ids.slice(0, 12) };

    let answer: Verdict | undefined;
    let problem: string | undefined;
    let costUsd = 0;
    for (let attempt = 0; attempt < 2 && !answer && !opts.signal?.aborted; attempt++) {
      const submit = tool("submit_verdict", "Submit your verdict. Call exactly once.", toolSchema(VerdictSchema), async (args: unknown) => {
        const v = parseArgs(VerdictSchema, args);
        const why = checkVerdict(v, slice, ruleIds);
        if (why) {
          problem = why;
          throw new Error(why);
        }
        answer = v;
        return "Recorded.";
      });
      const run = await runAgent({
        agent: "drafter",
        dir: AGENT_DIR,
        prompt: [
          "The operator is about to send a cold email and asks: should I send this?",
          `Target: ${JSON.stringify(form)} (location "home" = the operator's own country, ${homeCountry()}).`,
          ...(opts.jobPost
            ? [
                "The job post they are answering (apply rules about the role or the company to it; do_instead may point at something specific in it):",
                `<<<${opts.jobPost.slice(0, MAX_JOB_POST)}>>>`,
              ]
            : []),
          `Their similar past emails, computed by the app: ${JSON.stringify(given)}`,
          `Your rules:\n${rules.map((r) => `- [${r.id}] ${r.text}`).join("\n")}`,
          "Only rules about whom to contact, which address to use, which companies or which roles to apply for can decide the verdict.",
          "Rules about the email itself (resume, personalisation, follow-ups) never decide it; at most they add a tip to do_instead on a go.",
          "Cite only rules whose text is actually about this target. Decide:",
          '- "go": the deciding rules support sending this as described (e.g. a published address, a role or company type your rules favour).',
          '- "change": a rule says to send, but differently (e.g. a published inbox instead of a guessed address). Put the change in do_instead.',
          '- "skip": a rule says not to contact this kind of target, or the job post is for a role your rules say not to apply for.',
          '- "no_rule": no rule covers this target. Then rule_ids is [], basis "evidence_only", and do_instead is a suggestion based only on the numbers' +
            (slice.n < MIN_SIMILAR ? ` (there are fewer than ${MIN_SIMILAR} similar emails, so set do_instead to null).` : "."),
          "For change and skip, do_instead must say what to do instead, as one concrete action (e.g. \"Send to their published careers@ inbox.\").",
          `Headline: one short plain sentence to the operator about this exact target (${slice.label}). Don't mention any country, company type or person that isn't in the target.`,
          "Copy the slice exactly as given. Never invent numbers or rule IDs.",
          ...(attempt && problem ? [`Your last answer was rejected: ${problem}. Fix that.`] : []),
          "Call submit_verdict exactly once.",
        ].join("\n"),
        tools: [submit],
        allowedTools: ["submit_verdict"],
        maxTurns: 3,
        signal: opts.signal,
      });
      costUsd += run.costs.totalCostUsd;
      if (!answer && !problem) problem = "no verdict was submitted";
    }
    runLog(STORE_DIR).add({ kind: "preflight", status: answer ? "done" : "error", costUsd, proposalIds: [] });
    if (!answer) throw new PreflightError(`The AI couldn't give a consistent answer (${problem}). Try again.`);
    return { ...finalVerdict(answer, slice), costUsd };
  });
}

export interface EmailResult extends EmailDraft {
  /** The past emails it learned from, with their outcomes. */
  examples: Omit<Example, "body">[];
  /** True when those were the made-up sample bodies, not the operator's real emails. */
  sample: boolean;
  costUsd: number;
}

/**
 * Write the email to send: following RULES.md and the verdict, personalised from the job post, and modelled on
 * the operator's past emails that got replies (picked in code, interested ones first). Nothing is sent.
 */
export function draftEmail(
  form: PreflightForm,
  verdict: { verdict: string; rule_ids: string[]; do_instead: string | null },
  opts: { signal?: AbortSignal; jobPost?: string } = {},
): Promise<EmailResult> {
  return withLock(async () => {
    const rows = loadEvidence();
    const slice = computeSlice(rows, form);
    const { bodies, sample } = loadBodies();
    const examples = pickExamples(rows, bodies, slice.evidence_ids);
    const rules = parseRules(readFileSync(join(AGENT_DIR, RULES_PATH), "utf8"));
    const said = (o: string) => (o === "reply_positive" ? "got an INTERESTED reply" : o === "no_reply" ? "got no reply" : "got a reply (not interested)");

    let draft: EmailDraft | undefined;
    let problem: string | undefined;
    let costUsd = 0;
    for (let attempt = 0; attempt < 2 && !draft && !opts.signal?.aborted; attempt++) {
      const submit = tool("submit_email", "Submit the email draft. Call exactly once.", toolSchema(EmailDraftSchema), async (args: unknown) => {
        const d = parseArgs(EmailDraftSchema, args);
        const why = checkEmail(d, rules.map((r) => r.id), examples.map((e) => e.id));
        if (why) {
          problem = why;
          throw new Error(why);
        }
        // IDs belong in rule_id/example_id (shown as chips), not in the sentence.
        const plain = (t: string) => t.replace(/\s*\((?:(?:R|ev|syn)-[\w-]+[,\s]*)+\)/g, "").trim();
        draft = { ...d, body: d.body.replace(/\\n/g, "\n"), notes: d.notes.map((n) => ({ ...n, text: plain(n.text) })) };
        return "Recorded.";
      });
      const run = await runAgent({
        agent: "drafter",
        dir: AGENT_DIR,
        prompt: [
          "Write the cold email the operator should send. It is never sent by you; they copy it.",
          `Target: ${JSON.stringify(form)} (location "home" = ${homeCountry()}).`,
          `The pre-flight verdict: ${JSON.stringify(verdict)}. If it says to change something, the email must already do it.`,
          `Your rules:\n${rules.map((r) => `- [${r.id}] ${r.text}`).join("\n")}`,
          ...(opts.jobPost ? ["The job post (personalise the opening and the skills you mention to it):", `<<<${opts.jobPost.slice(0, MAX_JOB_POST)}>>>`] : []),
          "The operator's past emails, with what happened. Write like the ones that got replies, especially interested ones; avoid what the unanswered ones do:",
          ...examples.map((e) => `[${e.id}] ${said(e.outcome)}:\n<<<${e.body}>>>`),
          "Keep it short (under 150 words), specific, in the operator's voice. Use <company> and <person> for names, sign as <candidate>. Never invent experience beyond what the past emails say.",
          "notes: 2 to 4 short reasons in plain words (no IDs or data field names in the text), each pointing at the rule (rule_id) or past email (example_id) it follows, or null.",
          ...(attempt && problem ? [`Your last answer was rejected: ${problem}. Fix that.`] : []),
          "Call submit_email exactly once.",
        ].join("\n"),
        tools: [submit],
        allowedTools: ["submit_email"],
        maxTurns: 3,
        signal: opts.signal,
      });
      costUsd += run.costs.totalCostUsd;
      if (!draft && !problem) problem = "no email was submitted";
    }
    runLog(STORE_DIR).add({ kind: "preflight", status: draft ? "done" : "error", costUsd, proposalIds: [] });
    if (!draft) throw new PreflightError(`Couldn't write the email (${problem}). Try again.`);
    return { ...draft, examples: examples.map((e) => ({ id: e.id, company: e.company, outcome: e.outcome })), sample, costUsd };
  });
}

/**
 * Read a pasted job post into the four answers, where the post says. Unclear answers stay null for the
 * operator to pick. The answers are only pre-filled in the form; the operator confirms them before checking.
 */
export function readJobPost(jobPost: string, opts: { signal?: AbortSignal } = {}): Promise<JobPostAnswers & { costUsd: number }> {
  return withLock(async () => {
    let answers: JobPostAnswers | undefined;
    const submit = tool("submit_answers", "Submit what the job post tells you. Call exactly once.", toolSchema(JobPostAnswersSchema), async (args: unknown) => {
      answers = parseArgs(JobPostAnswersSchema, args);
      return "Recorded.";
    });
    const run = await runAgent({
      agent: "drafter",
      dir: AGENT_DIR,
      prompt: [
        `Read this job post for an operator based in ${homeCountry()}. Fill in only what the post makes clear; use null when it doesn't say.`,
        `- location: "home" if the company or role is in ${homeCountry()}, "abroad" otherwise (a remote role for a foreign company is abroad).`,
        '- company: "startup", "scaleup", "enterprise", "agency" (agencies, consultancies, IT services) or "other".',
        '- who: whom the post tells you to contact: "recruiter", "hiring_manager", "founder" or "careers_inbox". null if it only says "apply".',
        '- address: "published" if the post gives an email address; otherwise null.',
        "- role: the job title. company_name: the company's name, or null.",
        `<<<${jobPost.slice(0, MAX_JOB_POST)}>>>`,
        "Call submit_answers exactly once.",
      ].join("\n"),
      tools: [submit],
      allowedTools: ["submit_answers"],
      maxTurns: 2,
      signal: opts.signal,
    });
    runLog(STORE_DIR).add({ kind: "preflight", status: answers ? "done" : run.status, costUsd: run.costs.totalCostUsd, proposalIds: [] });
    if (!answers) throw new PreflightError("Couldn't read the job post. Pick the answers yourself, or try again.");
    return { ...answers, costUsd: run.costs.totalCostUsd };
  });
}

/**
 * "Turn this into a rule": a suggestion to add `ruleText`, backed by the pre-flight slice. It passes the same
 * checks as an Analyst proposal (evidence bar included), gets the Skeptic's review, and waits for approval.
 */
export async function turnIntoRule(form: PreflightForm, ruleText: string, headline: string) {
  const store = proposalStore(STORE_DIR);
  const rows = loadEvidence();
  const slice = computeSlice(rows, form);
  if (slice.n < MIN_SIMILAR) throw new ReviewError(`Too few similar emails to make a rule (${slice.n}).`, 400);
  let id: string;
  try {
    id = propose(
      { runId: `preflight-${randomUUID()}`, rows, readRules: () => readFileSync(join(AGENT_DIR, RULES_PATH), "utf8"), store, maxPerRun: 1 },
      {
        op: "add",
        title: headline.slice(0, 60),
        rule_text: ruleText,
        evidence_ids: slice.evidence_ids.slice(0, 40),
        slice: slice.filter,
        n: slice.n,
        metric: `${slice.replies} human replies, ${slice.bounces} bounces out of ${slice.n}`,
        rationale: `From a pre-flight check on ${slice.label}: ${headline}`,
        confidence: 0.5,
      },
    ).id;
  } catch (err) {
    const msg = (err as Error).message;
    throw new ReviewError(
      /not enough evidence/.test(msg) ? "Not enough evidence for a rule yet. A rule needs 10+ similar emails with a clear difference, or an interested reply." : msg,
      400,
    );
  }
  const review = await runSkeptic(id).catch(() => undefined);
  return { proposal: store.get(id)!, reviewed: Boolean(review?.critique) };
}
