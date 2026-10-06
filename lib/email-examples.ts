// Past email bodies the email writer learns from, picked in code: replies first (interested ones on top),
// from the emails most like the target, plus a couple that got no reply for contrast.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HUMAN_REPLY, isSend, type Evidence } from "./evidence";

export interface Bodies {
  bodies: Record<string, string>;
  /** True when these are the made-up samples (email-bodies.synthetic.json), not the operator's real emails. */
  sample: boolean;
}

/** The real bodies (gitignored email-bodies.local.json) when present, otherwise the labelled samples. */
export function loadBodies(dataDir = join(/* turbopackIgnore: true */ process.cwd(), "data")): Bodies {
  const real = join(dataDir, "email-bodies.local.json");
  if (existsSync(real)) return { bodies: JSON.parse(readFileSync(real, "utf8")), sample: false };
  const synthetic = join(dataDir, "email-bodies.synthetic.json");
  return { bodies: existsSync(synthetic) ? JSON.parse(readFileSync(synthetic, "utf8")) : {}, sample: true };
}

export interface Example {
  id: string;
  company: string;
  outcome: string;
  body: string;
}

const rank = (r: Evidence) => (r.outcome === "reply_positive" ? 0 : HUMAN_REPLY.has(r.outcome) ? 1 : 2);

/**
 * Up to `replies` emails that got a human reply (interested first) and `silent` that got none, preferring
 * the similar emails (`similarIds`) and filling up from all the operator's emails. Only emails with a body.
 */
export function pickExamples(rows: Evidence[], bodies: Record<string, string>, similarIds: string[], replies = 3, silent = 2): Example[] {
  const similar = new Set(similarIds);
  const pool = rows
    .filter((r) => isSend(r) && bodies[r.id])
    .sort((a, b) => rank(a) - rank(b) || Number(similar.has(b.id)) - Number(similar.has(a.id)) || (b.sent_at ?? "").localeCompare(a.sent_at ?? ""));
  const replied = pool.filter((r) => HUMAN_REPLY.has(r.outcome)).slice(0, replies);
  const quiet = pool.filter((r) => r.outcome === "no_reply").sort((a, b) => Number(similar.has(b.id)) - Number(similar.has(a.id))).slice(0, silent);
  return [...replied, ...quiet].map((r) => ({ id: r.id, company: r.company, outcome: r.outcome, body: bodies[r.id] }));
}
