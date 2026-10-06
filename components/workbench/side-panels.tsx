"use client";
// The right rail: Your rules, Emails, History and Activity, minimised until opened. Each opens a drawer
// over the right side, so the page underneath doesn't move.
import { Activity, BookOpen, Check, History, Mail, Monitor, Moon, PenLine, Sun, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { WorkspaceState } from "@/lib/workspace";
import type { EvidenceResponse, Proposal } from "./api";
import { groupLabel, marketName, plural, RESULT, ruleName, shortDate, when } from "./format";
import { DraftPanel } from "./draft-panel";
import { collapse } from "./narrate";
import type { ActivityEvent } from "./use-run";

export type Drawer = "rules" | "emails" | "history" | "activity" | "draft";

const RAIL: [Drawer, string, typeof BookOpen][] = [
  ["rules", "Your rules", BookOpen],
  ["draft", "Draft", PenLine],
  ["emails", "Emails", Mail],
  ["history", "History", History],
  ["activity", "Activity", Activity],
];

export type Theme = "system" | "light" | "dark";
const THEME: Record<Theme, [string, typeof Sun]> = { system: ["System", Monitor], light: ["Light", Sun], dark: ["Dark", Moon] };

export function Rail({ open, onOpen, theme, onTheme }: { open?: Drawer; onOpen: (d?: Drawer) => void; theme: Theme; onTheme: (t: Theme) => void }) {
  const [themeLabel, ThemeIcon] = THEME[theme];
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close the theme menu on a click outside it, or on Escape.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);
  return (
    <aside className="rail" aria-label="More">
      {RAIL.map(([key, label, Icon]) => (
        <button key={key} className="rail-btn" aria-pressed={open === key} onClick={() => onOpen(open === key ? undefined : key)}>
          <Icon size={20} strokeWidth={1.8} aria-hidden />
          {label}
        </button>
      ))}
      <div ref={menuRef} className="theme-wrap">
        <button className="rail-btn" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((o) => !o)} title="Theme">
          <ThemeIcon size={20} strokeWidth={1.8} aria-hidden />
          {themeLabel}
        </button>
        {menu && (
          <div className="theme-menu" role="menu" aria-label="Theme">
            {(Object.keys(THEME) as Theme[]).map((t) => {
              const [label, Icon] = THEME[t];
              return (
                <button key={t} role="menuitemradio" aria-checked={t === theme} onClick={() => (onTheme(t), setMenu(false))}>
                  <Icon size={16} aria-hidden />
                  <span>{label}</span>
                  {t === theme && <Check size={16} aria-hidden />}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}

interface DrawerProps {
  drawer: Drawer;
  onClose: () => void;
  state: WorkspaceState;
  /** The suggestion the Emails drawer shows. */
  focus?: Proposal;
  emails: Record<string, EvidenceResponse>;
  onNeedEmails: (id: string) => void;
  events: ActivityEvent[];
  running: boolean;
  locked?: string;
  onUndo: (sha: string) => void;
  /** After something that costs money, so the AI cost refreshes. */
  onSpent: () => void;
}

export function DrawerPanel(props: DrawerProps) {
  const { drawer, state } = props;
  let title: string;
  let body: React.ReactNode;

  if (drawer === "rules") {
    title = "Your rules";
    body = <RulesBody {...props} />;
  } else if (drawer === "draft") {
    title = "Draft an email";
    body = <DraftPanel state={state} locked={props.locked} onSpent={props.onSpent} />;
  } else if (drawer === "emails") {
    title = props.focus ? `${plural(props.focus.check.n, "email")} ${groupLabel(props.focus.slice)}` : "Emails";
    body = props.focus ? <Emails p={props.focus} {...props} /> : <p className="small">Pick a suggestion to see the emails behind it.</p>;
  } else if (drawer === "history") {
    title = "What changed";
    body = <HistoryBody {...props} />;
  } else {
    title = props.running ? "This run" : "Last run";
    const last = state.spend.last;
    const steps = collapse(props.events.filter((e) => e.kind === "step" || e.kind === "error" || (e.agent === "system" && e.kind === "end")));
    body = (
      <>
        {last && !props.running && <p className="small">{when(last.at)}. Cost ${last.costUsd.toFixed(3)}.</p>}
        {steps.length ? (
          <ol className="mini">
            {steps.map((e) => (
              <li key={e.id} className={`step${e.isError ? " err" : ""}`}>
                <span>{e.agent === "skeptic" ? "Reviewer" : e.agent === "system" ? "Done" : "Analyst"}</span>
                <span>{e.text}{e.times > 1 ? ` (${e.times} times)` : ""}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="small">Run the Analyst to see what it looks at and what it finds, step by step.</p>
        )}
      </>
    );
  }

  return (
    <aside className={`drawer${drawer === "draft" ? " wide" : ""}`} role="dialog" aria-label={title}>
      <div className="drawer-head">
        <h2>{title}</h2>
        <button className="close" aria-label="Close" onClick={props.onClose}><X size={18} aria-hidden /></button>
      </div>
      <div className="drawer-body">{body}</div>
    </aside>
  );
}

function Emails({ p, emails, onNeedEmails }: DrawerProps & { p: Proposal }) {
  useEffect(() => onNeedEmails(p.id), [onNeedEmails, p.id]);
  const e = emails[p.id];
  const mentioned = new Set(p.evidence_ids);
  if (!e) return <p className="small">Loading…</p>;
  const rows = [...e.rows].sort((a, b) => Number(mentioned.has(b.id)) - Number(mentioned.has(a.id)));
  return (
    <>
      <ol className="mini">
        {rows.map((r) => {
          const [label, cls] = RESULT[r.outcome] ?? [r.outcome, "p-none"];
          return (
            <li key={r.id} className={`email${mentioned.has(r.id) ? " mentioned" : ""}`}>
              <span><b>{r.company}</b> <span className="where">{marketName(r.market)}, {r.sent_at ? shortDate(r.sent_at) : "not sent"}{r.duplicate_of_earlier ? ", second email" : ""}</span></span>
              <span className={`pill ${cls}`}>{label}</span>
            </li>
          );
        })}
      </ol>
    </>
  );
}

/** Each rule, and on click where it came from: the change that last wrote it (git blame) and its trailers. */
function RulesBody({ state, locked, onUndo }: DrawerProps) {
  const [open, setOpen] = useState<string>();
  const backed = state.rules.filter((r) => r.origin && !r.origin.initial).length;
  return (
    <>
      <p className="small">{backed} of {state.rules.length} backed by your results. Click a rule to see where it came from.</p>
      <div className="meter good"><i style={{ width: `${state.rules.length ? (backed / state.rules.length) * 100 : 0}%` }} /></div>
      <ol className="mini">
        {state.rules.map((r) => {
          const o = r.origin;
          const tag: [string, string] = !o || o.initial || o.n === undefined ? ["Untested", "plain"] : o.trial ? [`Trying out · ${plural(o.n, "email")}`, "try"] : o.n < 10 ? [`${plural(o.n, "email")} · weak`, "weak"] : [plural(o.n, "email"), "ok"];
          const h = o && state.history.find((x) => x.sha === o.sha);
          const isOpen = open === r.id;
          return (
            <li key={r.id}>
              <button className="rule-row rule-btn" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? undefined : r.id)}>
                <span className="rn">{ruleName(r.id)}</span>
                <span>{r.text}</span>
                <span className={`rtag ${tag[1]}`}>{tag[0]}</span>
              </button>
              {isOpen && o && (
                <div className="blame">
                  {o.initial ? (
                    <p>From your July plan, {when(o.date)}. Not tested against results yet.</p>
                  ) : (
                    <>
                      <p><b>{h?.title ?? "Changed"}</b> on {when(o.date)}{o.approvedBy ? ", approved by you" : ""}.</p>
                      {o.n !== undefined && <p>Learned from {plural(o.n, "email")}{o.critique ? ` · ${plainCritique(o.critique)}` : ""}.</p>}
                      {o.emails && o.emails.length > 0 && (
                        <div className="chips">
                          {o.emails.map((e) => {
                            const [label, cls] = RESULT[e.outcome] ?? [e.outcome, "p-none"];
                            return <span key={e.id} className={`pill ${cls}`} title={label}>{e.company}</span>;
                          })}
                        </div>
                      )}
                    </>
                  )}
                  <p className="fine">Saved as change {o.sha.slice(0, 7)}</p>
                  {h?.undoable && (
                    <button className="btn sm" style={{ alignSelf: "flex-start" }} disabled={Boolean(locked)} title={locked} onClick={() => onUndo(o.sha)}>
                      Undo this change
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </>
  );
}

/** "caution (0.70) — skeptic" → "reviewer unsure, 70% sure". */
function plainCritique(c: string): string {
  const m = /^(\w+) \(([\d.]+)\)/.exec(c);
  const v: Record<string, string> = { support: "reviewer agreed", caution: "reviewer unsure", oppose: "reviewer disagreed" };
  return m ? `${v[m[1]] ?? m[1]}, ${Math.round(Number(m[2]) * 100)}% sure` : c;
}

const FILTERS: [string, string, (h: WorkspaceState["history"][number]) => boolean][] = [
  ["all", "All", () => true],
  ["rule", "Rule changes", (h) => h.kind === "rule"],
  ["dismiss", "Turned down", (h) => h.kind === "dismiss"],
  ["undo", "Cancelled", (h) => h.kind === "undo" || h.undone],
];

function HistoryBody({ state, locked, onUndo }: DrawerProps) {
  const [filter, setFilter] = useState("all");
  const keep = FILTERS.find((f) => f[0] === filter)![2];
  const items = state.history.filter(keep);
  return (
    <>
      <div className="filter-chips" role="group" aria-label="Show">
        {FILTERS.map(([key, label]) => (
          <button key={key} className="fchip" aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>
        ))}
      </div>
      <ol className="mini">
        {items.map((h) => (
          <li key={h.sha}>
            <div className="top"><b>{h.title}{h.undone && <span className="rtag plain" style={{ marginLeft: 8 }}>Cancelled</span>}</b><span>{when(h.date)}</span></div>
            {h.detail && <p className="hist-detail">{h.detail}</p>}
            {h.note && <p className="fine">{h.note}</p>}
            {h.undoable && (
              <button className="btn sm" style={{ alignSelf: "flex-start" }} disabled={Boolean(locked)} title={locked} onClick={() => onUndo(h.sha)}>
                Undo
              </button>
            )}
          </li>
        ))}
        {!items.length && <li><p>Nothing here yet.</p></li>}
      </ol>
      <p className="fine">Undo cancels a change. Both stay here as a record.</p>
    </>
  );
}
