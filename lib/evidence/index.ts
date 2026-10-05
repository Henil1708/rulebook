// Evidence: load, filter, slice stats. Pure functions apart from loadEvidence.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Evidence {
  id: string;
  sent_at: string | null;
  company: string;
  domain: string;
  market: string;
  company_stage: string;
  segment: string;
  inbox_type: string;
  address_pattern: string;
  recipient: string;
  subject: string;
  outcome: string;
  outcome_at: string | null;
  days_to_outcome: number | null;
  responder: string | null;
  source: "gmail" | "synthetic";
  attrs_inferred: boolean;
  duplicate_of_earlier: boolean;
  note?: string;
}

export const FILTER_FIELDS = [
  "id", "company", "market", "company_stage", "segment", "inbox_type", "address_pattern",
  "outcome", "responder", "source", "attrs_inferred", "duplicate_of_earlier",
] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];

type Scalar = string | boolean;
/** A value, a list (any of), or `{ not: ... }`. Compared as strings, so "true" matches true. */
export type FieldFilter = Scalar | Scalar[] | { not: Scalar | Scalar[] };
export type Filter = Partial<Record<FilterField, FieldFilter>>;
/** Inclusive `YYYY-MM-DD` bounds on `sent_at`. Rows without `sent_at` never match a window. */
export interface Window {
  from?: string;
  to?: string;
}

export const HUMAN_REPLY = new Set(["reply_rejection", "reply_positive", "reply_redirect"]);

export function loadEvidence({ synthetic = false, dataDir = join(process.cwd(), "data") } = {}): Evidence[] {
  const read = (f: string) => JSON.parse(readFileSync(join(dataDir, f), "utf8")) as Evidence[];
  return synthetic ? [...read("evidence.real.json"), ...read("evidence.synthetic.json")] : read("evidence.real.json");
}

/** An outreach we actually sent and can judge: dated, not pending, not an inbound event. */
export function isSend(row: Evidence): boolean {
  return row.sent_at !== null && row.outcome !== "pending" && row.outcome !== "inbound_contact";
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Throws on unknown fields or bad dates, so a tool caller gets a clear error instead of a silent empty slice. */
export function validateQuery(filter: Filter = {}, window: Window = {}): void {
  for (const k of Object.keys(filter)) {
    if (!(FILTER_FIELDS as readonly string[]).includes(k)) throw new Error(`unknown filter field "${k}". Use one of: ${FILTER_FIELDS.join(", ")}`);
  }
  for (const d of [window.from, window.to]) {
    if (d !== undefined && !DATE.test(d)) throw new Error(`window dates must be YYYY-MM-DD, got "${d}"`);
  }
}

function matches(value: unknown, f: FieldFilter): boolean {
  if (typeof f === "object" && !Array.isArray(f)) return !matches(value, f.not);
  return (Array.isArray(f) ? f : [f]).some((v) => String(v) === String(value));
}

export function filterEvidence(rows: Evidence[], filter: Filter = {}, window: Window = {}): Evidence[] {
  validateQuery(filter, window);
  return rows.filter((r) => {
    if (window.from && (!r.sent_at || r.sent_at < window.from)) return false;
    if (window.to && (!r.sent_at || r.sent_at > window.to)) return false;
    return Object.entries(filter).every(([k, f]) => matches(r[k as FilterField], f as FieldFilter));
  });
}

export interface SliceStats {
  n: number;
  humanReplies: number;
  positive: number;
  rejections: number;
  bounces: number;
  /** humanReplies / n, 0 when n = 0. */
  rate: number;
}

export function stats(sends: Evidence[]): SliceStats {
  const count = (pred: (r: Evidence) => boolean) => sends.filter(pred).length;
  const humanReplies = count((r) => HUMAN_REPLY.has(r.outcome));
  return {
    n: sends.length,
    humanReplies,
    positive: count((r) => r.outcome === "reply_positive"),
    rejections: count((r) => r.outcome === "reply_rejection"),
    bounces: count((r) => r.outcome === "bounce"),
    rate: sends.length ? humanReplies / sends.length : 0,
  };
}

/** Stats over the sends in a slice, plus those rows. */
export function sliceStats(rows: Evidence[], filter: Filter = {}, window: Window = {}): SliceStats & { rows: Evidence[] } {
  const sends = filterEvidence(rows, filter, window).filter(isSend);
  return { ...stats(sends), rows: sends };
}
