"use client";
// "Should I send this?" as a page: your input on the left (job post + four questions), the answer on the right
// (a slim verdict, then the email to send). The numbers are counted by the app; the AI words the verdict and the email.
import { ChevronDown, ChevronLeft, ChevronRight, Copy, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, type CheckRecord, type CheckSummary, type EmailResult, type PreflightForm, type PreflightResult, type WorkspaceState } from "./api";
import { plural, RESULT, ruleName, shortDate, when } from "./format";

type Answers = Partial<PreflightForm>;
type Async<T> = { phase: "idle" } | { phase: "busy" } | { phase: "done"; value: T } | { phase: "error"; message: string };

const QUESTIONS: { key: keyof PreflightForm; label: string; options: [string, string][] }[] = [
  { key: "location", label: "Where is the company?", options: [["home", "Same country as me"], ["abroad", "Abroad"]] },
  { key: "company", label: "What kind of company?", options: [["startup", "Startup"], ["scaleup", "Scale-up"], ["enterprise", "Enterprise"], ["agency", "Agency or services"], ["other", "Other"]] },
  { key: "who", label: "Who are you emailing?", options: [["recruiter", "Recruiter"], ["hiring_manager", "Hiring manager"], ["founder", "Founder"], ["careers_inbox", "Careers inbox"]] },
  { key: "address", label: "How did you get the address?", options: [["published", "Published"], ["guessed", "Guessed"]] },
];

const VERDICT: Record<PreflightResult["verdict"], [string, string]> = {
  go: ["Go", "go"],
  change: ["Change it first", "change"],
  skip: ["Skip", "skip"],
  no_rule: ["No rule yet", "none"],
};

interface Props {
  state: WorkspaceState;
  locked?: string;
  onOpenRule: (id: string) => void;
  onSpent: () => void;
  onProposed: (text: string) => void;
}

export function CheckPage({ state, locked, onOpenRule, onSpent, onProposed }: Props) {
  const [answers, setAnswers] = useState<Answers>({});
  const [jobPost, setJobPost] = useState("");
  const [role, setRole] = useState<string>();
  const [companyName, setCompanyName] = useState<string>();
  const [fromPost, setFromPost] = useState<Set<keyof PreflightForm>>(new Set());
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string>();
  const [verdict, setVerdict] = useState<Async<PreflightResult>>({ phase: "idle" });
  const [emails, setEmails] = useState<EmailResult[]>([]);
  const [shown, setShown] = useState(0);
  const [writing, setWriting] = useState<Async<null>>({ phase: "idle" });
  const [proposing, setProposing] = useState(false);
  const [checkId, setCheckId] = useState<string>();
  /** The saved check being looked at: its date and the rulebook commit it was based on. */
  const [opened, setOpened] = useState<Pick<CheckRecord, "at" | "rulesSha">>();
  const [recent, setRecent] = useState<CheckSummary[]>([]);
  const loadRecent = useCallback(() => void api.checks().then(setRecent, () => {}), []);
  useEffect(loadRecent, [loadRecent]);
  const complete = QUESTIONS.every((q) => answers[q.key]);
  const post = jobPost.trim() || undefined;

  const readPost = async () => {
    setReading(true);
    setReadError(undefined);
    try {
      const r = await api.readJobPost(jobPost);
      const found = QUESTIONS.map((q) => q.key).filter((k) => r[k]);
      setAnswers((a) => ({ ...a, ...Object.fromEntries(found.map((k) => [k, r[k]])) }));
      setFromPost(new Set(found));
      setRole(r.role);
      setCompanyName(r.company_name ?? undefined);
    } catch (err) {
      setReadError((err as Error).message);
    } finally {
      setReading(false);
      onSpent();
    }
  };

  const check = async () => {
    setVerdict({ phase: "busy" });
    setEmails([]);
    setWriting({ phase: "idle" });
    try {
      const r = await api.preflight(answers as PreflightForm, { job_post: post, role, company_name: companyName });
      setVerdict({ phase: "done", value: r });
      setCheckId(r.checkId);
      setOpened({ at: new Date().toISOString(), rulesSha: state.head?.sha });
      loadRecent();
    } catch (err) {
      setVerdict({ phase: "error", message: (err as Error).message });
    }
    onSpent();
  };

  const write = async (r: PreflightResult) => {
    setWriting({ phase: "busy" });
    try {
      const e = await api.writeEmail(answers as PreflightForm, { verdict: r.verdict, rule_ids: r.rule_ids, do_instead: r.do_instead }, post, checkId);
      setEmails((list) => [...list, e]);
      setShown(emails.length); // the new version is shown
      setWriting({ phase: "idle" });
      loadRecent();
    } catch (err) {
      setWriting({ phase: "error", message: (err as Error).message });
    }
    onSpent();
  };

  /** Reopen a saved check exactly as it was, with every email version. */
  const open = async (id: string) => {
    try {
      const c = await api.check(id);
      setAnswers(c.form);
      setJobPost(c.jobPost ?? "");
      setRole(c.role);
      setCompanyName(c.company);
      setFromPost(new Set());
      setVerdict({ phase: "done", value: c.verdict });
      setEmails(c.emails);
      setShown(Math.max(0, c.emails.length - 1));
      setWriting({ phase: "idle" });
      setCheckId(c.id);
      setOpened({ at: c.at, rulesSha: c.rulesSha });
    } catch (err) {
      setVerdict({ phase: "error", message: (err as Error).message });
    }
  };

  const reset = () => {
    setAnswers({});
    setJobPost("");
    setRole(undefined);
    setCompanyName(undefined);
    setFromPost(new Set());
    setVerdict({ phase: "idle" });
    setEmails([]);
    setWriting({ phase: "idle" });
    setCheckId(undefined);
    setOpened(undefined);
  };

  // Rule changes made after this check: its verdict may be out of date.
  const changedSince = opened && opened.rulesSha && state.head && opened.rulesSha !== state.head.sha
    ? state.history.filter((h) => (h.kind === "rule" || h.kind === "undo") && h.date > opened.at).map((h) => h.title.replace(/^You /, ""))
    : [];

  const makeRule = async (r: PreflightResult) => {
    if (!r.do_instead) return;
    setProposing(true);
    try {
      await api.turnIntoRule(answers as PreflightForm, r.do_instead, r.headline);
      onProposed("Added to your suggestions. It becomes a rule only when you apply it.");
    } catch (err) {
      setVerdict({ phase: "error", message: (err as Error).message });
    } finally {
      setProposing(false);
      onSpent();
    }
  };

  return (
    <div className="check-page">
      <section className="check-input" aria-label="The email you want to send">
        <div>
          <div className="check-title">
            <h1>Should I send this?</h1>
            {verdict.phase !== "idle" && <button className="btn sm quiet" onClick={reset}><Plus size={14} aria-hidden />New check</button>}
          </div>
          <p className="small">Describe who you&apos;re about to email. You&apos;ll get a verdict from your rules and your past emails, and an email to send.</p>
        </div>

        <div className="jd">
          <label htmlFor="jd">Job post <span className="fine">optional</span></label>
          <textarea id="jd" rows={6} value={jobPost} maxLength={6000} placeholder="Paste the job description here" onChange={(e) => setJobPost(e.target.value)} />
          <div className="jd-foot">
            {role ? <span className="fine">Role: {role}</span> : <span />}
            <button className="btn sm" disabled={jobPost.trim().length < 40 || reading || Boolean(locked)} onClick={() => void readPost()}>
              {reading ? "Reading…" : "Fill in from the job post"}
            </button>
          </div>
          {readError && <p className="err">{readError}</p>}
        </div>

        {QUESTIONS.map((q) => (
          <fieldset key={q.key} className="q">
            <legend>{q.label}{fromPost.has(q.key) && <span className="from-post">from the job post</span>}</legend>
            <div className="choices">
              {q.options.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className="choice"
                  aria-pressed={answers[q.key] === value}
                  onClick={() => (setAnswers((a) => ({ ...a, [q.key]: value })), setFromPost((f) => new Set([...f].filter((k) => k !== q.key))))}
                >
                  {label}
                </button>
              ))}
            </div>
          </fieldset>
        ))}

        <button className="btn primary big" disabled={!complete || verdict.phase === "busy" || Boolean(locked)} title={locked} onClick={() => void check()}>
          {verdict.phase === "busy" ? "Checking…" : "Check"}
        </button>

        {recent.length > 0 && (
          <nav className="recent" aria-label="Recent checks">
            <h2>Recent</h2>
            <ol>
              {recent.slice(0, 8).map((c) => {
                const [label, tone] = VERDICT[c.verdict];
                return (
                  <li key={c.id}>
                    <button className="recent-item" aria-current={c.id === checkId} onClick={() => void open(c.id)}>
                      <span className="recent-name">{[c.role, c.company].filter(Boolean).join(" · ") || c.headline}</span>
                      <span className="recent-meta">
                        <span className={`dot ${tone}`} aria-hidden />{label} · {shortDate(c.at)}{c.emails ? ` · ${plural(c.emails, "email")}` : ""}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>
        )}
      </section>

      <section className="check-output" aria-label="Verdict and email" aria-live="polite">
        <div className="check-output-inner">
        {verdict.phase === "idle" && (
          <div className="check-empty">
            <p><b>Your answer appears here.</b></p>
            <p className="small">A verdict first (go, change, skip), then an email written from your rules and the emails that got replies.</p>
          </div>
        )}
        {verdict.phase === "busy" && <div className="recheck" role="status"><span className="spin" aria-hidden />Checking your rules and your past emails…</div>}
        {verdict.phase === "error" && <p className="err" role="alert">{verdict.message}</p>}
        {verdict.phase === "done" && (
          <>
            {changedSince.length > 0 && opened && (
              <p className="stale">
                Checked on {when(opened.at)}. Since then: {changedSince.slice(0, 3).join(", ")}.
                <button className="link" disabled={!complete || Boolean(locked)} onClick={() => void check()}>Check again</button>
              </p>
            )}
            <VerdictStrip r={verdict.value} onOpenRule={onOpenRule} onMakeRule={() => void makeRule(verdict.value)} proposing={proposing} locked={locked} />
            {emails.length === 0 && writing.phase !== "busy" && (
              <button className={`btn${verdict.value.verdict === "skip" ? "" : " primary"} big write-btn`} disabled={Boolean(locked)} title={locked} onClick={() => void write(verdict.value)}>
                {verdict.value.verdict === "skip" ? "Write it anyway" : "Write the email"}
              </button>
            )}
            {writing.phase === "busy" && <div className="recheck" role="status"><span className="spin" aria-hidden />Writing it from your rules and the emails that got replies…</div>}
            {writing.phase === "error" && <p className="err" role="alert">{writing.message} <button className="link" onClick={() => void write(verdict.value)}>Try again</button></p>}
            {emails[shown] && (
              <EmailCard
                e={emails[shown]}
                version={shown + 1}
                versions={emails.length}
                onVersion={(n) => setShown(n - 1)}
                busy={writing.phase === "busy"}
                onOpenRule={onOpenRule}
                onRewrite={() => void write(verdict.value)}
              />
            )}
          </>
        )}
        </div>
      </section>
    </div>
  );
}

function VerdictStrip({ r, onOpenRule, onMakeRule, proposing, locked }: { r: PreflightResult; onOpenRule: (id: string) => void; onMakeRule: () => void; proposing: boolean; locked?: string }) {
  const [label, tone] = VERDICT[r.verdict];
  const s = r.slice;
  const noRule = r.verdict === "no_rule";
  const headline = noRule ? "No rule yet for this kind of target." : r.headline;
  return (
    <div className={`vstrip ${tone}`}>
      <div className="vstrip-top">
        <span className="v-label">{label}</span>
        <h2>{headline}</h2>
      </div>
      {noRule && r.tooFew ? (
        <p className="vstrip-meta">Too few similar emails to suggest anything yet ({s.n}).</p>
      ) : (
        <p className="vstrip-meta">
          <b>{plural(s.replies, "reply", "replies")}</b> from {plural(s.n, "similar email")}
          {s.bounces > 0 && <span className="bounced"> · {plural(s.bounces, "bounce")}</span>}
          <span className="slice"> · {r.relaxed.length ? "closest match: " : ""}{s.label}</span>
        </p>
      )}
      {r.rule_ids.length > 0 && (
        <p className="vstrip-rules">
          Based on {r.rule_ids.map((id) => <button key={id} className="cite" onClick={() => onOpenRule(id)} title="Why this rule?">{ruleName(id)}</button>)}
        </p>
      )}
      {r.do_instead && (
        <p className="instead"><b>{noRule ? "Suggestion" : "Do this instead"}</b> {r.do_instead}</p>
      )}
      {noRule && !r.tooFew && r.do_instead && (
        <div className="vstrip-foot">
          <span className="fine">A suggestion from your history, not an approved rule.</span>
          <button className="btn sm" disabled={proposing || Boolean(locked)} title={locked} onClick={onMakeRule}>{proposing ? "Adding…" : "Turn this into a rule"}</button>
        </div>
      )}
    </div>
  );
}

interface EmailCardProps {
  e: EmailResult;
  version: number;
  versions: number;
  onVersion: (n: number) => void;
  busy: boolean;
  onOpenRule: (id: string) => void;
  onRewrite: () => void;
}

function EmailCard({ e, version, versions, onVersion, busy, onOpenRule, onRewrite }: EmailCardProps) {
  const [copied, setCopied] = useState(false);
  const [why, setWhy] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`Subject: ${e.subject}\n\n${e.body}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard refused: the text is on screen to select by hand.
    }
  };
  return (
    <article className="mail" aria-label="Your email">
      <header className="mail-bar">
        <div className="mail-versions">
          <span className="mail-title">Your email</span>
          {versions > 1 && (
            <span className="pager" aria-label="Versions">
              <button className="icon" aria-label="Previous version" disabled={version === 1} onClick={() => onVersion(version - 1)}><ChevronLeft size={16} aria-hidden /></button>
              <span>{version} of {versions}</span>
              <button className="icon" aria-label="Next version" disabled={version === versions} onClick={() => onVersion(version + 1)}><ChevronRight size={16} aria-hidden /></button>
            </span>
          )}
        </div>
        <div className="mail-acts">
          <button className="btn sm quiet" disabled={busy} onClick={onRewrite}><RefreshCw size={14} aria-hidden />{busy ? "Writing…" : "Another version"}</button>
          <button className="btn sm primary" onClick={() => void copy()}><Copy size={14} aria-hidden />{copied ? "Copied" : "Copy"}</button>
        </div>
      </header>
      <dl className="mail-fields">
        <div><dt>To</dt><dd>{e.to}</dd></div>
        <div><dt>Subject</dt><dd className="subject">{e.subject}</dd></div>
      </dl>
      <div className="mail-body">{e.body}</div>
      <footer className="mail-why">
        <button className="link why-toggle" aria-expanded={why} onClick={() => setWhy((w) => !w)}>
          Why this email <ChevronDown size={14} aria-hidden style={{ transform: why ? "rotate(180deg)" : undefined }} />
        </button>
        {why && (
          <ul>
            {e.notes.map((n, i) => {
              const ex = n.example_id ? e.examples.find((x) => x.id === n.example_id) : undefined;
              return (
                <li key={i}>
                  {n.text}
                  {n.rule_id && <button className="cite" onClick={() => onOpenRule(n.rule_id!)}>{ruleName(n.rule_id)}</button>}
                  {ex && <span className={`pill ${RESULT[ex.outcome]?.[1] ?? "p-none"}`}>{ex.company}: {RESULT[ex.outcome]?.[0] ?? ex.outcome}</span>}
                </li>
              );
            })}
          </ul>
        )}
        {e.sample && <p className="fine">Learned from sample emails, not your real ones.</p>}
      </footer>
    </article>
  );
}
