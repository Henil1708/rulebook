// Typed fetch helpers for the workbench. Every write sends JSON (the CSRF guard requires it).
import type { FeedRow, SliceStats } from "@/lib/evidence";
import type { EmailResult, PreflightResult } from "@/lib/agents/preflight";
import type { JobPostAnswers, PreflightForm } from "@/lib/preflight";
import type { CheckRecord, CheckSummary } from "@/lib/store/checks";
import type { Proposal } from "@/lib/store/proposals";
import type { WorkspaceState } from "@/lib/workspace";

export type { CheckRecord, CheckSummary, EmailResult, FeedRow, PreflightForm, PreflightResult, Proposal, WorkspaceState };

export interface EvidenceResponse {
  rows: FeedRow[];
  stats: SliceStats;
  total: number;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status, body.code);
  return body as T;
}

const post = (url: string, body: unknown = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const api = {
  state: () => fetch("/api/state", { cache: "no-store" }).then((r) => json<WorkspaceState>(r)),
  proposals: () => fetch("/api/proposals", { cache: "no-store" }).then((r) => json<{ proposals: Proposal[] }>(r)).then((r) => r.proposals),
  /** The emails behind one suggestion. */
  emails: (proposalId: string) => fetch(`/api/evidence?proposal=${encodeURIComponent(proposalId)}`, { cache: "no-store" }).then((r) => json<EvidenceResponse>(r)),
  init: () => post("/api/workspace/init").then((r) => json<{ created: boolean }>(r)),
  accept: (id: string, text?: string) => post(`/api/proposals/${id}/accept`, text === undefined ? {} : { text }).then((r) => json<{ sha: string }>(r)),
  dismiss: (ids: string[], reason: string) => post("/api/proposals/dismiss", { ids, reason }).then((r) => json<{ sha: string }>(r)),
  combine: (ids: string[], signal?: AbortSignal) =>
    fetch("/api/proposals/combine", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }), signal }).then((r) => json<{ proposal: Proposal; costUsd: number }>(r)),
  preflight: (form: PreflightForm, extra: { job_post?: string; role?: string; company_name?: string }) =>
    post("/api/preflight", { ...form, ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v)) }).then((r) => json<PreflightResult & { checkId: string }>(r)),
  checks: () => fetch("/api/checks", { cache: "no-store" }).then((r) => json<{ checks: CheckSummary[] }>(r)).then((r) => r.checks),
  check: (id: string) => fetch(`/api/checks/${encodeURIComponent(id)}`, { cache: "no-store" }).then((r) => json<CheckRecord>(r)),
  writeEmail: (form: PreflightForm, verdict: Pick<PreflightResult, "verdict" | "rule_ids" | "do_instead">, jobPost?: string, checkId?: string) =>
    post("/api/preflight/email", { form, verdict, ...(jobPost ? { job_post: jobPost } : {}), ...(checkId ? { check_id: checkId } : {}) }).then((r) => json<EmailResult>(r)),
  readJobPost: (jobPost: string) => post("/api/preflight/read", { job_post: jobPost }).then((r) => json<JobPostAnswers>(r)),
  turnIntoRule: (form: PreflightForm, rule_text: string, headline: string) =>
    post("/api/preflight/rule", { form, rule_text, headline }).then((r) => json<{ proposal: Proposal; reviewed: boolean }>(r)),
  undo: (sha: string) => post("/api/history/undo", { sha }).then((r) => json<{ sha: string; restored: string[] }>(r)),
  runAnalyst: (signal: AbortSignal) => fetch("/api/analyst/run", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal }),
};
