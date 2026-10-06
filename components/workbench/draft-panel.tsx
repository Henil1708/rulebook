"use client";
// Before/after: the same target drafted with the rulebook at two commits, side by side.
// Rule IDs the Drafter cites are highlighted; rules that differ between the two versions are marked.
import { useEffect, useMemo, useState } from "react";
import type { Rule } from "@/lib/rules";
import { api, type DraftResult, type FeedRow, type Target, type WorkspaceState } from "./api";
import { ruleName, when } from "./format";

type Column = { phase: "idle" } | { phase: "loading" } | { phase: "done"; result: DraftResult } | { phase: "error"; message: string };

interface Props {
  state: WorkspaceState;
  locked?: string;
  onSpent: () => void;
}

export function DraftPanel({ state, locked, onSpent }: Props) {
  const [rows, setRows] = useState<FeedRow[]>([]);
  const [company, setCompany] = useState("");
  const [notes, setNotes] = useState("");
  const [left, setLeft] = useState("v0");
  const [cols, setCols] = useState<[Column, Column]>([{ phase: "idle" }, { phase: "idle" }]);
  useEffect(() => void api.allEmails().then((e) => setRows(e.rows), () => {}), []);

  // One target per company: its most recent email's details.
  const targets = useMemo(() => {
    const by = new Map<string, FeedRow>();
    for (const r of rows) if (!by.has(r.company)) by.set(r.company, r);
    return [...by.values()].sort((a, b) => a.company.localeCompare(b.company));
  }, [rows]);
  const versions = state.history.filter((h) => h.kind === "rule" && !h.undone);
  const busy = cols.some((c) => c.phase === "loading");

  const run = async () => {
    const r = targets.find((t) => t.company === company);
    const target: Target = r
      ? { company: r.company, market: r.market, company_stage: r.company_stage, segment: r.segment, inbox_type: r.inbox_type, address_pattern: r.address_pattern }
      : { company };
    if (notes.trim()) target.notes = notes.trim();
    const one = async (ref: string): Promise<Column> => {
      try {
        const result = await api.draft(target, ref);
        return result.draft ? { phase: "done", result } : { phase: "error", message: `No draft came back (${result.error ?? result.status}). Try again.` };
      } catch (err) {
        return { phase: "error", message: (err as Error).message };
      }
    };
    setCols([{ phase: "loading" }, { phase: "idle" }]);
    const a = await one(left);
    setCols([a, { phase: "loading" }]);
    const b = await one("HEAD");
    setCols([a, b]);
    onSpent();
  };

  // Rules whose text differs between the two versions drafted.
  const [ra, rb] = cols.map((c) => (c.phase === "done" ? c.result.rules : undefined));
  const changed = new Set(
    ra && rb ? [...new Set([...ra, ...rb].map((r) => r.id))].filter((id) => ra.find((r) => r.id === id)?.text !== rb.find((r) => r.id === id)?.text) : [],
  );

  return (
    <div className="draft">
      <div className="draft-form">
        <label>
          Company
          <input list="draft-companies" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Pick or type a company" />
          <datalist id="draft-companies">{targets.map((t) => <option key={t.company} value={t.company} />)}</datalist>
        </label>
        <label>
          Note for the draft
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional, e.g. senior full-stack role" maxLength={300} />
        </label>
        <label>
          Compare with
          <select value={left} onChange={(e) => setLeft(e.target.value)}>
            <option value="v0">Your July plan</option>
            {versions.map((h) => <option key={h.sha} value={h.sha}>{h.title}, {when(h.date)}</option>)}
          </select>
        </label>
        <button className="btn primary" disabled={!company.trim() || busy || Boolean(locked)} title={locked} onClick={() => void run()}>
          {busy ? "Drafting…" : "Draft both"}
        </button>
      </div>
      <div className="compare">
        <DraftColumn title={left === "v0" ? "Your July plan" : versions.find((h) => h.sha === left)?.title ?? "Earlier rules"} col={cols[0]} changed={changed} />
        <DraftColumn title="Your rules now" col={cols[1]} changed={changed} />
      </div>
    </div>
  );
}

function DraftColumn({ title, col, changed }: { title: string; col: Column; changed: Set<string> }) {
  return (
    <section className="draft-col" aria-label={title}>
      <h3>{title}</h3>
      {col.phase === "idle" && <p className="small">Pick a company and press Draft both.</p>}
      {col.phase === "loading" && <div className="recheck" role="status"><span className="spin" aria-hidden />Drafting with these rules…</div>}
      {col.phase === "error" && <p className="err" role="alert">{col.message}</p>}
      {col.phase === "done" && <DraftView r={col.result} changed={changed} />}
    </section>
  );
}

function DraftView({ r, changed }: { r: DraftResult; changed: Set<string> }) {
  const d = r.draft!;
  const rule = (id: string) => r.rules.find((x) => x.id === id);
  return (
    <>
      {d.decision === "skip" ? (
        <p className="skip"><b>Wouldn&apos;t send.</b> <Cited text={d.reason ?? ""} rule={rule} changed={changed} /></p>
      ) : (
        <div className="email-draft">
          <p><span className="m">To</span> {d.to}</p>
          <p><span className="m">Subject</span> {d.subject}</p>
          <p className="email-body"><Cited text={d.body ?? ""} rule={rule} changed={changed} /></p>
        </div>
      )}
      {d.cited_rules.length > 0 && (
        <div className="cites">
          <span className="fine">Rules it followed</span>
          {d.cited_rules.map((id) => (
            <span key={id} className={`cite${changed.has(id) ? " changed" : ""}`} title={rule(id)?.text}>
              {ruleName(id)}{changed.has(id) ? " · changed" : ""}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

/** Replace "(R-002)" with a highlighted "Rule 2" that shows the rule's text on hover. */
function Cited({ text, rule, changed }: { text: string; rule: (id: string) => Rule | undefined; changed: Set<string> }) {
  return (
    <>
      {text.split(/\((R-\d{3,})\)/).map((part, i) =>
        i % 2 ? (
          <mark key={i} className={`cite${changed.has(part) ? " changed" : ""}`} title={rule(part)?.text}>{ruleName(part)}</mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}
