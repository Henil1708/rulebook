// workspace/.rulebook/checks.json: every "Should I send this?" check, with its answers, the job post, the verdict
// and every email version written for it, so the operator can reopen them later. Working state, not history.
import { join } from "node:path";
import type { EmailResult, PreflightResult } from "../agents/preflight";
import type { PreflightForm } from "../preflight";
import { readJson, writeJson } from "./json";

export interface CheckRecord {
  id: string; // C-###
  at: string;
  form: PreflightForm;
  jobPost?: string;
  role?: string;
  company?: string;
  /** The rulebook commit the verdict was based on, to tell when rules changed since. */
  rulesSha?: string;
  verdict: PreflightResult;
  emails: EmailResult[];
}

export type CheckSummary = Pick<CheckRecord, "id" | "at" | "role" | "company"> & { verdict: PreflightResult["verdict"]; headline: string; emails: number };

export function checkStore(dir: string) {
  const file = join(dir, "checks.json");
  const list = (): CheckRecord[] => readJson<CheckRecord[]>(file, []);
  return {
    list,
    get: (id: string) => list().find((c) => c.id === id),
    /** Newest first, small enough for the Recent list. */
    summaries(): CheckSummary[] {
      return list()
        .slice()
        .reverse()
        .map((c) => ({ id: c.id, at: c.at, role: c.role, company: c.company, verdict: c.verdict.verdict, headline: c.verdict.headline, emails: c.emails.length }));
    },
    add(input: Omit<CheckRecord, "id" | "at" | "emails">): CheckRecord {
      const all = list();
      const next = Math.max(0, ...all.map((c) => Number(c.id.slice(2)))) + 1;
      const c: CheckRecord = { id: `C-${String(next).padStart(3, "0")}`, at: new Date().toISOString(), emails: [], ...input };
      writeJson(file, [...all, c]);
      return c;
    },
    addEmail(id: string, email: EmailResult): CheckRecord {
      const all = list();
      const c = all.find((x) => x.id === id);
      if (!c) throw new Error(`${id} not found`);
      c.emails.push(email);
      writeJson(file, all);
      return c;
    },
  };
}
