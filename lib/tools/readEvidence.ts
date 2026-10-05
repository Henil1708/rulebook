// read_evidence: compact slice aggregates + at most 15 sample rows. Never the whole file (G13–G16).
import { tool } from "@open-gitagent/gitagent";
import { z } from "zod";
import {
  FILTER_FIELDS, FilterSchema, HUMAN_REPLY, WindowSchema, sliceStats, stats,
  type Evidence, type FilterField, type Filter, type SliceStats, type Window,
} from "../evidence";
import { parseArgs, toolSchema } from "./schema";

export const MAX_SAMPLE = 15;
const MAX_GROUPS = 20;

export interface ReadEvidenceArgs {
  filter?: Filter;
  window?: Window;
  groupBy?: FilterField;
}

type Rounded = Omit<SliceStats, "rate"> & { rate: number };
const round = (s: SliceStats): Rounded => ({ ...s, rate: Math.round(s.rate * 1000) / 1000 });

/** Replies and bounces first (they carry the signal), then newest first. */
const signal = (r: Evidence) => (HUMAN_REPLY.has(r.outcome) ? 0 : r.outcome === "bounce" ? 1 : 2);

function compact(r: Evidence) {
  const { id, sent_at, company, market, company_stage, segment, inbox_type, address_pattern, outcome, duplicate_of_earlier, source, note } = r;
  return { id, sent_at, company, market, company_stage, segment, inbox_type, address_pattern, outcome, duplicate_of_earlier, source, ...(note ? { note } : {}) };
}

export function readEvidence(rows: Evidence[], { filter = {}, window = {}, groupBy }: ReadEvidenceArgs = {}) {
  if (groupBy && !(FILTER_FIELDS as readonly string[]).includes(groupBy)) throw new Error(`unknown groupBy field "${groupBy}"`);
  const { rows: sends, ...total } = sliceStats(rows, filter, window);

  const groups = groupBy
    ? Object.entries(Object.groupBy(sends, (r) => String(r[groupBy])))
        .map(([key, g]) => ({ key, ...round(stats(g ?? [])) }))
        .sort((a, b) => b.n - a.n)
        .slice(0, MAX_GROUPS)
    : undefined;

  const sample = [...sends]
    .sort((a, b) => signal(a) - signal(b) || (b.sent_at ?? "").localeCompare(a.sent_at ?? ""))
    .slice(0, MAX_SAMPLE)
    .map(compact);

  return {
    query: { filter, window, ...(groupBy ? { groupBy } : {}) },
    stats: round(total),
    ...(groups ? { groups } : {}),
    sample,
    omittedRows: sends.length - sample.length,
    note: "Counts are sends only (dated, not pending, not inbound). Human reply = reply_rejection | reply_positive | reply_redirect.",
  };
}

export const ReadEvidenceArgsSchema = z
  .object({ filter: FilterSchema.optional(), window: WindowSchema.optional(), groupBy: z.enum(FILTER_FIELDS).optional() })
  .strict();

/** `getRows` is called per request so the real/synthetic toggle applies immediately. */
export function readEvidenceTool(getRows: () => Evidence[]) {
  return tool(
    "read_evidence",
    `Query outreach evidence. Returns slice stats (n, humanReplies, positive, rejections, bounces, rate), optional per-group stats, and up to ${MAX_SAMPLE} sample rows with IDs. Cite row IDs as evidence.`,
    toolSchema(ReadEvidenceArgsSchema),
    async (args: unknown) => JSON.stringify(readEvidence(getRows(), parseArgs(ReadEvidenceArgsSchema, args))),
  );
}
