"use client";
// One rule's waiting suggestions: tick one to apply it, tick several to combine them, or dismiss them all.
// Dismiss, edit and combine open a sheet over the page, so the page and the decision bar never move.
import { useEffect, useRef, useState } from "react";
import type { SliceStats } from "@/lib/evidence";
import type { RuleView } from "@/lib/workspace";
import type { EvidenceResponse, Proposal } from "./api";
import { groupLabel, pct, plural, ruleName, VERDICT } from "./format";
import { titleOf, type RuleGroup } from "./groups";

export type Sheet =
  | { kind: "dismiss"; reason: string; busy?: boolean; error?: string }
  | { kind: "edit"; id: string; text: string; busy?: boolean; error?: string }
  | { kind: "combine"; ids: string[]; phase: "drafting" | "ready" | "error"; draft?: Proposal; text: string; busy?: boolean; error?: string };

interface Props {
  group: RuleGroup;
  rule?: RuleView;
  baseline?: SliceStats;
  picked: string[];
  onPick: (id: string, on: boolean) => void;
  why?: string;
  onWhy: (id?: string) => void;
  showAll: boolean;
  onShowAll: (on: boolean) => void;
  emails: Record<string, EvidenceResponse>;
  onNeedEmails: (id: string) => void;
  onSeeEmails: (id: string) => void;
  /** Why deciding is paused right now (a run holds the workspace), if it is. */
  locked?: string;
  sheet?: Sheet;
  setSheet: (s?: Sheet) => void;
  onApply: (id: string, text?: string) => void;
  onDismiss: () => void;
  onCombine: () => void;
}

export function RuleReview(props: Props) {
  const { group, rule, picked, locked, sheet } = props;
  const all = group.suggestions;
  const single = all.length === 1;
  const shown = props.showAll ? all : all.slice(0, 3);
  const k = single ? 1 : picked.length;
  const multi = k >= 2;
  const one = single ? all[0] : k === 1 ? all.find((p) => p.id === picked[0]) : undefined;
  const cantCombine = multi && all.filter((p) => picked.includes(p.id)).some((p) => p.op !== "modify");
  const heading = group.ruleId ? ruleName(group.ruleId) : "A new rule";

  const hint = locked
    ? locked
    : single
      ? group.ruleId ? `Applying updates ${heading.toLowerCase()}. You can undo it.` : "Applying adds this rule. You can undo it."
      : k === 0
        ? "Tick a suggestion to apply it. Tick more than one to combine them."
        : k === 1
          ? `The other ${all.length - 1} close as replaced.`
          : cantCombine
            ? "Removing a rule can't be combined with rewording it. Tick one."
            : `${k} picked: they'll be combined into one wording. You'll see it before anything changes.`;

  return (
    <div className="main">
      <div className="article-wrap">
        <article className="sugg">
          <div>
            <p className="kicker">{single ? (group.ruleId ? `Suggested change to ${heading.toLowerCase()}` : "Suggested new rule") : `${all.length} suggestions for ${heading.toLowerCase()}`}</p>
            <h1>{single ? titleOf(all[0]) : heading}</h1>
          </div>
          {rule && (
            <div className="change">
              <div className="was"><small>{heading} today</small><p>{rule.text}</p></div>
            </div>
          )}
          {!single && <p className="lead-note">Tick the one you want. Tick more than one to combine them. Strongest first.</p>}
          <ol className="opts">
            {shown.map((p, i) => (
              <Option key={p.id} p={p} n={i + 1} single={single} on={single || picked.includes(p.id)} {...props} />
            ))}
          </ol>
          {all.length > 3 && (
            <button className="more" onClick={() => props.onShowAll(!props.showAll)}>
              {props.showAll ? "Show only the strongest 3" : `Show ${all.length - 3} more (weaker)`}
            </button>
          )}
        </article>
      </div>

      <div className="decide" role="group" aria-label="Decide">
        <div>
          {multi ? (
            <button className="btn primary big" disabled={Boolean(locked) || cantCombine} onClick={props.onCombine}>
              Combine &amp; apply {k} <kbd>A</kbd>
            </button>
          ) : (
            <>
              <button className="btn primary big" disabled={Boolean(locked) || !one} onClick={() => one && props.onApply(one.id)}>
                {single ? "Apply change" : "Apply"} <kbd>A</kbd>
              </button>
              {(!one || one.op !== "retire") && (
                <button className="btn big" disabled={Boolean(locked) || !one} onClick={() => one && props.setSheet({ kind: "edit", id: one.id, text: one.rule_text ?? "" })}>
                  Change the wording <kbd>E</kbd>
                </button>
              )}
            </>
          )}
          <button className="btn big quiet" disabled={Boolean(locked)} onClick={() => props.setSheet({ kind: "dismiss", reason: suggestedReason(all) })}>
            {single ? "Dismiss" : `Dismiss all ${all.length}`} <kbd>R</kbd>
          </button>
          <span className="hint">{hint}</span>
        </div>
      </div>

      {sheet && <SheetView {...props} sheet={sheet} heading={heading} />}
    </div>
  );
}

function Option({ p, n, single, on, ...props }: Props & { p: Proposal; n: number; single: boolean; on: boolean }) {
  const open = props.why === p.id;
  const v = p.critique ? VERDICT[p.critique.verdict] : undefined;
  return (
    <li className={`opt${on && !single ? " on" : ""}`}>
      {single ? <span /> : <input type="checkbox" id={`pk-${p.id}`} checked={on} onChange={(e) => props.onPick(p.id, e.target.checked)} aria-keyshortcuts={n <= 9 ? String(n) : undefined} />}
      <label htmlFor={single ? undefined : `pk-${p.id}`}>
        <b>{single ? (p.op === "retire" ? `Remove ${ruleName(p.rule_id).toLowerCase()}` : p.rule_text) : titleOf(p)}</b>
        <span>From {plural(p.check.n, "email")} {groupLabel(p.slice)} · {pct(p.check.n ? p.check.humanReplies / p.check.n : 0)} replied</span>
      </label>
      <span className="pills">
        {p.evidence_level === "early" && <span className="pill p-try" title="Based on an interested reply in a small group">Worth trying</span>}
        <span className={`pill ${v ? v[1] : "p-none"}`}>{v ? v[0] : p.critique_error ? "Review didn't finish" : "Not reviewed yet"}</span>
      </span>
      <button className="link why-btn" aria-expanded={open} onClick={() => props.onWhy(open ? undefined : p.id)}>
        {open ? "Hide the details" : "Why?"}
      </button>
      {open && <Why p={p} {...props} />}
    </li>
  );
}

function Why({ p, ...props }: Props & { p: Proposal }) {
  const { onNeedEmails } = props;
  useEffect(() => onNeedEmails(p.id), [onNeedEmails, p.id]);
  const e = props.emails[p.id];
  const rate = p.check.n ? p.check.humanReplies / p.check.n : 0;
  const base = props.baseline?.rate ?? 0;
  const scale = Math.max(rate, base, 0.01) * 1.25;
  const c = p.critique;
  const said = e && [
    e.stats.rejections && `${e.stats.rejections} turned you down`,
    e.stats.positive && `${e.stats.positive} ${e.stats.positive === 1 ? "was" : "were"} interested`,
    e.stats.humanReplies - e.stats.rejections - e.stats.positive && `${e.stats.humanReplies - e.stats.rejections - e.stats.positive} pointed you elsewhere`,
  ].filter(Boolean).join(", ");
  return (
    <div className="why">
      {p.evidence_level === "early" && (
        <p className="w-try"><b>Early sign:</b> {plural(p.check.positive ?? 1, "interested reply", "interested replies")} from {plural(p.check.n, "email")}. Try it on your next emails before relying on it.</p>
      )}
      {p.rule_text && props.group.suggestions.length > 1 && <p><b>Suggested wording:</b> {p.rule_text}</p>}
      <div className="barrow"><span>These {p.check.n} emails</span><span className="track"><i style={{ width: `${(rate / scale) * 100}%` }} /></span><b>{pct(rate)}</b></div>
      <div className="barrow muted"><span>All your emails</span><span className="track"><i style={{ width: `${(base / scale) * 100}%` }} /></span><b>{pct(base)}</b></div>
      <p>
        {e ? (e.stats.humanReplies ? `What the replies said: ${said}.` : "Nobody replied.") : "Loading the replies…"}
        {p.check.bounces ? ` ${plural(p.check.bounces, "email")} bounced.` : ""}
      </p>
      <div className="sure">
        <span>Analyst <b>{pct(p.confidence)}</b> sure</span>
        {c && <span className={VERDICT[c.verdict][2]}>{VERDICT[c.verdict][0]} · <b>{pct(c.adjusted_confidence)}</b> sure</span>}
      </div>
      {c ? (
        <>
          {c.override && <p className="w-unsure">Fewer than 10 emails can&apos;t prove a rule, so the app shows this as unsure.</p>}
          <ul>{c.concerns.map((x) => <li key={x}>{x}</li>)}</ul>
          <p className="small">{c.what_would_change_my_mind}</p>
        </>
      ) : (
        <p className="small">{p.critique_error ? "The reviewer stopped before giving an opinion." : "Not reviewed yet."} Look at the emails yourself before deciding.</p>
      )}
      <p className="small">{p.rationale}</p>
      <button className="link" style={{ alignSelf: "flex-start" }} onClick={() => props.onSeeEmails(p.id)}>See the emails</button>
    </div>
  );
}

function SheetView({ sheet, heading, ...props }: Props & { sheet: Sheet; heading: string }) {
  const field = useRef<HTMLTextAreaElement>(null);
  const [concerns, setConcerns] = useState(false);
  const ready = sheet.kind !== "combine" || sheet.phase === "ready";
  useEffect(() => {
    if (ready) field.current?.focus();
  }, [sheet.kind, ready]);
  const all = props.group.suggestions;
  const close = () => !sheet.busy && props.setSheet(undefined);
  let body;

  if (sheet.kind === "dismiss") {
    const single = all.length === 1;
    body = (
      <>
        <h2>Dismiss {single ? "this suggestion" : `all ${all.length} suggestions`}?</h2>
        <p className="small">Your reason is saved, so {single ? "it isn't" : "they aren't"} suggested again.</p>
        <label>Reason<textarea ref={field} rows={3} value={sheet.reason} placeholder="e.g. Most replies were rejections." onChange={(e) => props.setSheet({ ...sheet, reason: e.target.value })} /></label>
        {sheet.error && <p className="err" role="alert">{sheet.error}</p>}
        <div className="sheet-acts">
          <button className="btn primary big" disabled={sheet.reason.trim().length < 3 || sheet.busy || Boolean(props.locked)} onClick={props.onDismiss}>{sheet.busy ? "Dismissing…" : "Dismiss"}</button>
          <button className="btn big quiet" onClick={close}>Cancel</button>
        </div>
      </>
    );
  } else if (sheet.kind === "edit") {
    body = (
      <>
        <h2>Change the wording</h2>
        <p className="small">{heading} will read exactly as you write it.</p>
        <textarea ref={field} rows={4} value={sheet.text} maxLength={300} onChange={(e) => props.setSheet({ ...sheet, text: e.target.value })} aria-label="New wording" />
        {sheet.error && <p className="err" role="alert">{sheet.error}</p>}
        <div className="sheet-acts">
          <button className="btn primary big" disabled={sheet.text.trim().length < 10 || sheet.busy || Boolean(props.locked)} onClick={() => props.onApply(sheet.id, sheet.text)}>{sheet.busy ? "Applying…" : "Apply my wording"}</button>
          <button className="btn big quiet" onClick={close}>Cancel</button>
        </div>
      </>
    );
  } else {
    const d = sheet.draft;
    const c = d?.critique;
    body = (
      <>
        <div>
          <h2>New wording for {heading.toLowerCase()}</h2>
          <p className="small">AI merges your {sheet.ids.length} picks into one rule. Edit it, then apply.</p>
        </div>
        {sheet.phase === "drafting" && <div className="recheck" role="status"><span className="spin" aria-hidden />Writing it and asking the reviewer. About 20 seconds.</div>}
        {sheet.phase === "error" && <p className="err" role="alert">{sheet.error}</p>}
        {sheet.phase === "ready" && d && (
          <>
            <textarea ref={field} rows={3} value={sheet.text} maxLength={300} onChange={(e) => props.setSheet({ ...sheet, text: e.target.value })} aria-label="New wording" />
            <div className="facts-line">
              <span>{plural(d.check.n, "email")} · {pct(d.check.n ? d.check.humanReplies / d.check.n : 0)} replied</span>
              <span className={`pill ${c ? VERDICT[c.verdict][1] : "p-none"}`}>{c ? `${VERDICT[c.verdict][0]} · ${pct(c.adjusted_confidence)} sure` : "Not reviewed"}</span>
              {c && c.concerns.length > 0 && (
                <button className="link" aria-expanded={concerns} onClick={() => setConcerns((o) => !o)}>{concerns ? "Hide why" : "Why?"}</button>
              )}
            </div>
            {c && concerns && <ul className="concerns">{c.concerns.slice(0, 3).map((x) => <li key={x}>{x}</li>)}</ul>}
            {sheet.error && <p className="err" role="alert">{sheet.error}</p>}
          </>
        )}
        <div className="sheet-acts">
          {sheet.phase === "error" ? (
            <button className="btn primary big" onClick={props.onCombine}>Try again</button>
          ) : (
            <button className="btn primary big" disabled={sheet.phase !== "ready" || sheet.text.trim().length < 10 || sheet.busy || Boolean(props.locked)} onClick={() => d && props.onApply(d.id, sheet.text === d.rule_text ? undefined : sheet.text)}>
              {sheet.busy ? "Applying…" : `Apply to ${heading.toLowerCase()}`}
            </button>
          )}
          <button className="btn big quiet" onClick={close}>Cancel</button>
        </div>
      </>
    );
  }

  return (
    <>
      <button className="sheet-scrim" aria-label="Close" tabIndex={-1} onClick={close} />
      <section className="sheet" role="dialog" aria-modal="true" aria-label="Decide">{body}</section>
    </>
  );
}

/** Pre-filled when the reviewer disagreed with everything; otherwise the operator writes it. */
function suggestedReason(all: Proposal[]): string {
  const first = all[0].critique?.concerns[0];
  return all.every((p) => p.critique?.verdict === "oppose") && first ? `The reviewer disagreed: ${first}` : "";
}

