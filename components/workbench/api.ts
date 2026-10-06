// Typed fetch helpers for the workbench. Every write sends JSON (the CSRF guard requires it).
import type { FeedRow, SliceStats } from "@/lib/evidence";
import type { DraftResult, Target } from "@/lib/agents/drafter";
import type { Proposal } from "@/lib/store/proposals";
import type { WorkspaceState } from "@/lib/workspace";

export type { DraftResult, FeedRow, Proposal, Target, WorkspaceState };

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
  /** Every real email, to pick a company to draft for. */
  allEmails: () => fetch("/api/evidence", { cache: "no-store" }).then((r) => json<EvidenceResponse>(r)),
  draft: (target: Target, ref: string, signal?: AbortSignal) =>
    fetch("/api/drafter", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target, ref }), signal }).then((r) => json<DraftResult>(r)),
  undo: (sha: string) => post("/api/history/undo", { sha }).then((r) => json<{ sha: string; restored: string[] }>(r)),
  runAnalyst: (signal: AbortSignal) => fetch("/api/analyst/run", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal }),
};
