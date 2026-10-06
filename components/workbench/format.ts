// Display names for data codes, so the UI speaks the operator's language, not the schema's.
import type { Filter } from "@/lib/evidence";

export const INBOX: Record<string, string> = {
  careers_inbox: "careers@",
  hr_inbox: "hr@",
  generic_inbox: "info@ / contact@",
  named_person: "named person",
  founders_alias: "founders@",
  ats_portal: "ATS portal",
  inbound_recruiter: "recruiter reached out",
  ats_then_named_recruiter: "ATS, then a recruiter",
};

export const OUTCOME: Record<string, string> = {
  no_reply: "no reply",
  bounce: "bounced",
  auto_ack: "auto-reply",
  reply_rejection: "rejection",
  reply_redirect: "redirected",
  reply_positive: "positive reply",
  inbound_contact: "they reached out",
  pending: "pending",
};

export const FIELD: Record<string, string> = {
  market: "market",
  inbox_type: "inbox",
  address_pattern: "address",
  company_stage: "stage",
  segment: "segment",
  outcome: "outcome",
  duplicate_of_earlier: "re-send",
  attrs_inferred: "attributes inferred",
  source: "source",
  responder: "responder",
  company: "company",
  id: "row",
};

const HUMAN_REPLY = new Set(["reply_rejection", "reply_positive", "reply_redirect"]);

/** Tone of an outcome for the row marker: replies stand out, bounces warn, silence stays quiet. */
export function outcomeTone(outcome: string): "positive" | "reply" | "bounce" | "quiet" {
  if (outcome === "reply_positive" || outcome === "inbound_contact") return "positive";
  if (HUMAN_REPLY.has(outcome)) return "reply";
  if (outcome === "bounce") return "bounce";
  return "quiet";
}

const valueLabel = (field: string, v: unknown) => {
  const s = String(v);
  if (field === "inbox_type") return INBOX[s] ?? s;
  if (field === "outcome") return OUTCOME[s] ?? s;
  return s.replace(/_/g, " ");
};

/** `{market:{not:"IN"}, inbox_type:"named_person"}` → ["market is not IN", "inbox is named person"]. */
export function sliceParts(filter: Filter): string[] {
  return Object.entries(filter).map(([k, f]) => {
    const name = FIELD[k] ?? k;
    const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => valueLabel(k, x)).join(" or ") : valueLabel(k, v));
    return typeof f === "object" && f !== null && !Array.isArray(f) ? `${name} is not ${list(f.not)}` : `${name} is ${list(f)}`;
  });
}

export const pct = (x: number) => `${Math.round(x * 100)}%`;
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const shortSha = (sha: string) => sha.slice(0, 7);

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** "R-002" → "Rule 2". */
export const ruleName = (id?: string) => (id ? `Rule ${Number(id.slice(2))}` : "A new rule");

const MARKET: Record<string, string> = { IN: "India", UK: "the UK", US: "the US", DE: "Germany", NL: "the Netherlands", SG: "Singapore", PT: "Portugal", ES: "Spain", EE: "Estonia", IE: "Ireland", SE: "Sweden", AU: "Australia", CA: "Canada", global_remote: "remote", US_remote_india: "the US (remote)", unknown: "an unknown market" };
export const marketName = (m: string) => MARKET[m] ?? m;

/** A slice as the group of emails it describes: `{inbox_type:"careers_inbox", market:"IN"}` → "to careers@ inboxes in India". */
export function groupLabel(filter: Filter): string {
  const parts = Object.entries(filter).map(([k, f]) => {
    const not = typeof f === "object" && f !== null && !Array.isArray(f);
    const v = not ? f.not : f;
    const vals = (Array.isArray(v) ? v : [v]).map(String);
    if (k === "inbox_type") return `${not ? "not " : ""}to ${vals.map((x) => (INBOX[x] ?? x)).join(" or ")}${vals.every((x) => x.endsWith("_inbox")) ? " inboxes" : ""}`;
    if (k === "market") return `${not ? "outside" : "in"} ${vals.map(marketName).join(" or ")}`;
    if (k === "duplicate_of_earlier") return String(v) === "true" ? "sent a second time" : "first emails only";
    return `${FIELD[k] ?? k} ${not ? "not " : ""}${vals.map((x) => x.replace(/_/g, " ")).join(" or ")}`;
  });
  return parts.length ? parts.join(", ") : "all your emails";
}

/** An email's outcome as the operator would say it, with the pill style. */
export const RESULT: Record<string, [string, string]> = {
  reply_rejection: ["Turned you down", "p-down"],
  reply_positive: ["Interested", "p-yes"],
  reply_redirect: ["Pointed elsewhere", "p-form"],
  bounce: ["Bounced", "p-bounce"],
  no_reply: ["No reply", "p-none"],
  auto_ack: ["Auto-reply", "p-none"],
  inbound_contact: ["They reached out", "p-yes"],
  pending: ["Waiting", "p-none"],
};

export const VERDICT: Record<string, [string, string, string]> = {
  support: ["Reviewer agrees", "p-yes", "w-yes"],
  caution: ["Reviewer unsure", "p-unsure", "w-unsure"],
  oppose: ["Reviewer disagrees", "p-no", "w-no"],
};

export function when(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
