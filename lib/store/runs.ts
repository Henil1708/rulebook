// workspace/.rulebook/runs.json: one entry per agent run with what it cost. The UI's cost total comes from here,
// so it survives a page refresh and a server restart.
import { join } from "node:path";
import { readJson, writeJson } from "./json";

export interface RunRecord {
  at: string;
  kind: "analyst" | "skeptic" | "combine" | "drafter"; // an analyst run includes the Skeptic reviews it triggered; combine = draft + review
  status: string;
  costUsd: number;
  window?: { from: string; to: string };
  proposalIds: string[];
}

export interface Spend {
  totalCostUsd: number;
  runs: number;
  last?: RunRecord;
  /** RULEBOOK_BUDGET_USD (default $5). New runs are refused once totalCostUsd reaches it. */
  budgetUsd: number;
}

export const budgetUsd = () => Number(process.env.RULEBOOK_BUDGET_USD || 5);

export function runLog(dir: string) {
  const file = join(dir, "runs.json");
  const list = () => readJson<RunRecord[]>(file, []);
  return {
    list,
    add(r: Omit<RunRecord, "at">): RunRecord {
      const rec: RunRecord = { at: new Date().toISOString(), ...r };
      writeJson(file, [...list(), rec]);
      return rec;
    },
    spend(): Spend {
      const all = list();
      return { totalCostUsd: all.reduce((s, r) => s + r.costUsd, 0), runs: all.length, ...(all.length ? { last: all[all.length - 1] } : {}), budgetUsd: budgetUsd() };
    },
  };
}
