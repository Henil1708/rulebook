"use client";
// The 1B workbench: waiting suggestions grouped by rule (left), one rule at a time (centre), and a rail of
// minimised panels (right). Decisions open over the page and show a toast with Undo, so nothing jumps.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type EvidenceResponse, type Proposal, type WorkspaceState } from "./api";
import { plural, ruleName, VERDICT } from "./format";
import { groupByRule, type RuleGroup } from "./groups";
import { RuleReview, type Sheet } from "./rule-review";
import { DrawerPanel, Rail, type Drawer, type Theme } from "./side-panels";
import { TopBar } from "./top-bar";
import { useRun } from "./use-run";
import "./rulebook.css";

interface Toast {
  text: string;
  sha?: string;
  error?: boolean;
}

export function Workbench() {
  const [state, setState] = useState<WorkspaceState>();
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loadError, setLoadError] = useState<string>();
  const [chosen, setChosen] = useState<string>();
  const [picked, setPicked] = useState<string[]>([]);
  const [why, setWhy] = useState<string>();
  const [showAll, setShowAll] = useState(false);
  const [sheet, setSheet] = useState<Sheet>();
  const [drawer, setDrawer] = useState<Drawer>();
  const [emailFocus, setEmailFocus] = useState<string>();
  const [emails, setEmails] = useState<Record<string, EvidenceResponse>>({});
  const [toast, setToast] = useState<Toast>();
  const [settingUp, setSettingUp] = useState(false);
  const [theme, setTheme] = useState<Theme>("system");

  // The theme is a per-browser preference: read after mount so server and client render the same.
  useEffect(() => {
    try {
      const t = localStorage.getItem("rulebook-theme");
      if (t === "light" || t === "dark") setTheme(t);
    } catch {}
  }, []);
  const pickTheme = useCallback((t: Theme) => {
    setTheme(t);
    try {
      localStorage.setItem("rulebook-theme", t);
    } catch {}
  }, []);
  const themeAttr = theme === "system" ? undefined : theme;

  const refresh = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([api.state(), api.proposals()]);
      setState(s);
      setProposals(p);
      setLoadError(undefined);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, []);
  useEffect(() => void refresh(), [refresh]);

  const { run, events, start, stop, dismiss: clearRun } = useRun({
    onProposalStored: () => void api.proposals().then(setProposals),
    onFinished: () => void refresh(),
  });
  const running = run.phase === "running";

  // When a run ends, say what happened in a toast (over the page, so nothing moves).
  useEffect(() => {
    if (run.phase === "done") {
      const n = run.result.proposalIds.length;
      setToast({ text: n ? `${plural(n, "new suggestion")}, reviewed. This run cost $${run.result.totalCostUsd.toFixed(3)}.` : "Nothing new to suggest. Run it again after more replies come in." });
      clearRun();
    } else if (run.phase === "error") {
      setToast({ text: run.message, error: run.code !== "aborted" });
      clearRun();
    }
  }, [run, clearRun]);

  const groups = useMemo(() => groupByRule(proposals), [proposals]);
  const group: RuleGroup | undefined = groups.find((g) => g.key === chosen) ?? groups[0];
  const rule = state?.rules.find((r) => r.id === group?.ruleId);
  const locked = running ? "Deciding is paused while the Analyst saves its results." : state?.busy ? "Another run is updating your rules. Try again in a moment." : undefined;

  const select = useCallback((key?: string) => {
    setChosen(key);
    setPicked([]);
    setWhy(undefined);
    setShowAll(false);
    setSheet(undefined);
  }, []);

  const requested = useRef(new Set<string>());
  const loadEmails = useCallback((id: string) => {
    if (requested.current.has(id)) return;
    requested.current.add(id);
    api.emails(id).then((e) => setEmails((c) => ({ ...c, [id]: e })), () => requested.current.delete(id));
  }, []);

  const flash = useCallback((t: Toast) => setToast(t), []);
  useEffect(() => {
    if (!toast || toast.error) return;
    const t = setTimeout(() => setToast(undefined), toast.sha ? 8000 : 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const fail = (err: unknown) => (err instanceof ApiError && err.code === "busy" ? "Another run is updating your rules. Try again in a moment." : (err as Error).message);

  const apply = useCallback(
    async (id: string, text?: string) => {
      if (!group) return;
      const others = group.suggestions.length - (sheet?.kind === "combine" ? sheet.ids.length : 1);
      setSheet((s) => (s ? { ...s, busy: true, error: undefined } : s));
      try {
        const { sha } = await api.accept(id, text);
        const name = group.ruleId ? ruleName(group.ruleId) : "The new rule";
        select(undefined);
        await refresh();
        flash({ text: `${name} ${group.ruleId ? "updated" : "added"} and saved.${others > 0 ? ` The other ${plural(others, "suggestion")} closed as replaced.` : ""}`, sha });
      } catch (err) {
        if (sheet) setSheet((s) => (s ? { ...s, busy: false, error: fail(err) } : s));
        else flash({ text: fail(err), error: true });
      }
    },
    [group, sheet, select, refresh, flash],
  );

  const dismissAll = useCallback(async () => {
    if (!group || sheet?.kind !== "dismiss") return;
    const ids = group.suggestions.map((p) => p.id);
    setSheet({ ...sheet, busy: true, error: undefined });
    try {
      const { sha } = await api.dismiss(ids, sheet.reason);
      select(undefined);
      await refresh();
      flash({ text: `${ids.length === 1 ? "Dismissed" : `Dismissed all ${ids.length}`}. The Analyst won't suggest ${ids.length === 1 ? "it" : "them"} again.`, sha });
    } catch (err) {
      setSheet({ ...sheet, busy: false, error: fail(err) });
    }
  }, [group, sheet, select, refresh, flash]);

  const combine = useCallback(async () => {
    const ids = sheet?.kind === "combine" ? sheet.ids : picked;
    setSheet({ kind: "combine", ids, phase: "drafting", text: "" });
    try {
      const { proposal } = await api.combine(ids);
      setSheet((s) => (s?.kind === "combine" ? { ...s, phase: "ready", draft: proposal, text: proposal.rule_text ?? "" } : s));
    } catch (err) {
      setSheet((s) => (s?.kind === "combine" ? { ...s, phase: "error", error: fail(err) } : s));
    }
    void refresh(); // the cost changed
  }, [sheet, picked, refresh]);

  const undo = useCallback(
    async (sha: string) => {
      try {
        const { restored } = await api.undo(sha);
        await refresh();
        flash({ text: `Cancelled.${restored.length ? ` ${plural(restored.length, "suggestion")} waiting for you again.` : ""}` });
      } catch (err) {
        flash({ text: fail(err), error: true });
      }
    },
    [refresh, flash],
  );

  const setUp = useCallback(async () => {
    setSettingUp(true);
    try {
      await api.init();
      await refresh();
    } catch (err) {
      flash({ text: (err as Error).message, error: true });
    } finally {
      setSettingUp(false);
    }
  }, [refresh, flash]);

  const runAnalyst = useCallback(() => {
    setToast(undefined);
    void start();
  }, [start]);

  // Keyboard: J/K move between rules, 1-9 tick, A apply (or combine), E edit, R dismiss, Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === "Escape") {
        if (sheet && !sheet.busy) setSheet(undefined);
        else setDrawer(undefined);
        return;
      }
      if (sheet || e.metaKey || e.ctrlKey || e.altKey || t.closest("input, textarea, select, [contenteditable]")) return;
      if (!group) return;
      const i = groups.indexOf(group);
      const k = e.key.toLowerCase();
      const single = group.suggestions.length === 1;
      const one = single ? group.suggestions[0] : picked.length === 1 ? group.suggestions.find((p) => p.id === picked[0]) : undefined;
      if (k === "j" || k === "k") {
        const next = groups[i + (k === "j" ? 1 : -1)];
        if (next) select(next.key);
      } else if (/^[1-9]$/.test(k) && !single) {
        const p = group.suggestions[Number(k) - 1];
        if (p) setPicked((cur) => (cur.includes(p.id) ? cur.filter((x) => x !== p.id) : [...cur, p.id]));
      } else if (locked) {
        return;
      } else if (k === "a") {
        if (picked.length >= 2) void combine();
        else if (one) void apply(one.id);
      } else if (k === "e" && one && one.op !== "retire") {
        setSheet({ kind: "edit", id: one.id, text: one.rule_text ?? "" });
      } else if (k === "r") {
        setSheet({ kind: "dismiss", reason: "" });
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [group, groups, picked, sheet, locked, select, apply, combine]);

  if (loadError && !state) {
    return (
      <div className="rb" data-theme={themeAttr}><div className="welcome"><div className="panel" style={{ maxWidth: 520, margin: "0 auto" }}><h2>Rulebook couldn&apos;t load</h2><p className="small">{loadError}</p><button className="btn" onClick={() => void refresh()}>Try again</button></div></div></div>
    );
  }

  const firstVisit = state && (!state.initialised || (state.spend.runs === 0 && proposals.length === 0));
  const total = groups.reduce((n, g) => n + g.suggestions.length, 0);
  const focus = proposals.find((p) => p.id === emailFocus) ?? group?.suggestions.find((p) => p.id === picked[0]) ?? group?.suggestions[0];

  return (
    <div className="rb" data-theme={themeAttr}>
      <TopBar state={state} run={run} onRun={runAnalyst} onStop={stop} />
      {!state ? (
        <div className="welcome"><p className="small" style={{ textAlign: "center" }}>Loading…</p></div>
      ) : firstVisit && !running ? (
        <Welcome state={state} settingUp={settingUp} onSetUp={setUp} onRun={runAnalyst} />
      ) : (
        <div className="body">
          <nav className="list" aria-label="Suggestions">
            <h2>{total ? `${plural(total, "suggestion")} for ${plural(groups.length, "rule")}` : "All caught up"}</h2>
            {running && <div className="checking-row"><span className="spin" aria-hidden />New suggestions will appear here</div>}
            {(["look", "against"] as const).map((section) => {
              const gs = groups.filter((g) => g.against === (section === "against"));
              if (!gs.length) return null;
              return (
                <div key={section}>
                  <p className="group-label">{section === "look" ? "Worth a look" : "Reviewer advises against"}</p>
                  <ol>
                    {gs.map((g) => {
                      const best = g.suggestions[0];
                      const v = best.critique ? VERDICT[best.critique.verdict] : undefined;
                      const text = state.rules.find((r) => r.id === g.ruleId)?.text ?? best.rule_text;
                      return (
                        <li key={g.key}>
                          <button className="item" aria-current={g === group} onClick={() => select(g.key)}>
                            <b>{g.ruleId ? ruleName(g.ruleId) : "A new rule"}</b>
                            <span className="rule-text">{text}</span>
                            <span className="meta">
                              <span>{plural(g.suggestions.length, "suggestion")}</span>
                              <span className={v?.[2]}>{v ? (g.suggestions.length > 1 ? `Best: ${v[0].toLowerCase()}` : v[0]) : "Not reviewed yet"}</span>
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                </div>
              );
            })}
          </nav>

          {group ? (
            <RuleReview
              key={group.key}
              group={group}
              rule={rule}
              baseline={state.baseline}
              picked={picked}
              onPick={(id, on) => setPicked((cur) => (on ? [...cur, id] : cur.filter((x) => x !== id)))}
              why={why}
              onWhy={setWhy}
              showAll={showAll}
              onShowAll={setShowAll}
              emails={emails}
              onNeedEmails={loadEmails}
              onSeeEmails={(id) => (setEmailFocus(id), setDrawer("emails"))}
              locked={locked}
              sheet={sheet}
              setSheet={setSheet}
              onApply={apply}
              onDismiss={dismissAll}
              onCombine={combine}
            />
          ) : (
            <div className="main">
              <div className="article-wrap">
                <article className="sugg">
                  <div><p className="kicker">All caught up</p><h1>Nothing left to decide</h1></div>
                  <p className="lead-note">Run the Analyst again after more replies come in. Your rules and every change are in the panels on the right.</p>
                </article>
              </div>
            </div>
          )}

          {drawer && (
            <DrawerPanel
              drawer={drawer}
              onClose={() => setDrawer(undefined)}
              state={state}
              focus={focus}
              emails={emails}
              onNeedEmails={loadEmails}
              events={events}
              running={running}
              locked={locked}
              onUndo={(sha) => void undo(sha)}
            />
          )}
          <Rail open={drawer} onOpen={(d) => (setEmailFocus(undefined), setDrawer(d))} theme={theme} onTheme={pickTheme} />
        </div>
      )}

      {toast && (
        <div className={`toast${toast.error ? " error" : ""}`} role={toast.error ? "alert" : "status"}>
          <span>{toast.text}</span>
          {toast.sha && <button className="link" onClick={() => (setToast(undefined), void undo(toast.sha!))}>Undo</button>}
          {toast.error && <button className="link" onClick={() => setToast(undefined)}>Close</button>}
        </div>
      )}
    </div>
  );
}

function Welcome({ state, settingUp, onSetUp, onRun }: { state: WorkspaceState; settingUp: boolean; onSetUp: () => void; onRun: () => void }) {
  const why = !state.hasKey ? "Add OPENAI_API_KEY to .env.local and restart the app first." : undefined;
  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="col">
          <h1>See which of your outreach rules hold up</h1>
          <p className="lead">{state.baseline.n} of your emails have a known result. Rulebook compares them with your rules and suggests changes. A reviewer checks each suggestion, and nothing changes until you apply it.</p>
          <div>
            {state.initialised ? (
              <button className="btn primary big" disabled={Boolean(why)} onClick={onRun}>Run Analyst</button>
            ) : (
              <button className="btn primary big" disabled={settingUp} onClick={onSetUp}>{settingUp ? "Setting up…" : "Set up your rulebook"}</button>
            )}
          </div>
          <p className="fine">{why ?? (state.initialised ? "Takes about a minute and costs around 1 cent." : "Copies your July 2026 rules into a workspace that keeps every change.")}</p>
        </div>
        {state.rules.length > 0 && (
          <div className="panel">
            <h2>Your rules today</h2>
            <p className="small">Your July 2026 plan, before any results</p>
            <ol className="mini">
              {state.rules.map((r) => (
                <li key={r.id} className="rule-row"><span className="rn">{ruleName(r.id)}</span><span>{r.text}</span></li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </div>
  );
}
