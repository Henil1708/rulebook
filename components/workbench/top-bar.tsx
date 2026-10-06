"use client";
import { Check, CircleDollarSign } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { WorkspaceState } from "./api";
import { when } from "./format";
import type { RunState } from "./use-run";

interface Props {
  state?: WorkspaceState;
  run: RunState;
  onRun: () => void;
  onStop: () => void;
}

export function TopBar({ state, run, onRun, onStop }: Props) {
  const [costOpen, setCostOpen] = useState(false);
  const costRef = useRef<HTMLDivElement>(null);
  const costBtn = useRef<HTMLButtonElement>(null);

  // Close the cost panel on a click outside it (or its button), or on Escape.
  useEffect(() => {
    if (!costOpen) return;
    const onDown = (e: PointerEvent) => ![costRef, costBtn].some((r) => r.current?.contains(e.target as Node)) && setCostOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setCostOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [costOpen]);
  const running = run.phase === "running";
  const spend = state?.spend;
  const spent = spend?.totalCostUsd ?? 0;
  const budget = spend?.budgetUsd ?? 5;
  const near = spent >= budget * 0.8;
  const over = spent >= budget;
  const why = !state ? "Loading" : !state.hasKey ? "Add OPENAI_API_KEY to .env.local and restart" : over ? "You've reached your AI budget" : state.busy ? "Another run is updating your rules" : undefined;

  return (
    <header className="bar">
      <span className="brand">Rulebook</span>
      {state?.initialised && (
        <span className="saved" title={state.head?.subject}>
          <Check size={14} strokeWidth={2.4} aria-hidden />
          All changes saved
        </span>
      )}
      <div className="bar-right">
        {running && (
          <span className="status" role="status">
            <span className="spin" aria-hidden />
            {run.detail}
          </span>
        )}
        {state && !state.hasKey && <span className="warn-text">No OpenAI key</span>}
        <button ref={costBtn} className={`btn quiet cost-btn${near ? " near" : ""}`} aria-expanded={costOpen} onClick={() => setCostOpen((o) => !o)} title="What runs have cost so far">
          <CircleDollarSign size={15} aria-hidden />
          AI cost ${spent.toFixed(2)}
        </button>
        {running ? (
          <button className="btn" onClick={onStop}>Stop</button>
        ) : (
          <button className="btn primary" onClick={onRun} disabled={Boolean(why)} title={why}>Run Analyst</button>
        )}
      </div>
      {costOpen && (
        <div ref={costRef} className="cost-panel" role="dialog" aria-label="AI cost">
          <h2>AI cost so far</h2>
          <div className="big">${spent.toFixed(2)} <span>of your ${budget.toFixed(2)} budget</span></div>
          <div className={`meter${near ? " near" : ""}`}><i style={{ width: `${Math.min(100, (spent / budget) * 100)}%` }} /></div>
          <p className="small">
            {spend?.runs ? `${spend.runs} run${spend.runs === 1 ? "" : "s"} so far.` : "No runs yet."}
            {spend?.last && ` The last one, ${when(spend.last.at)}, cost $${spend.last.costUsd.toFixed(3)}.`}
          </p>
          {(near || over) && <p className="fine">{over ? "New runs are paused. Raise RULEBOOK_BUDGET_USD to run again." : "You're close to your budget. At the limit, new runs stop."}</p>}
        </div>
      )}
    </header>
  );
}
