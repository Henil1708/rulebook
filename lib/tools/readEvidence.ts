// read_evidence: compact slice aggregates + at most 15 sample rows. Never the whole file (G13–G16).
import { tool } from "@open-gitagent/gitagent";
import {
  FILTER_FIELDS, HUMAN_REPLY, sliceStats, stats,
  type Evidence, type FilterField, type Filter, type SliceStats, type Window,
} from "../evidence";

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

const fieldFilter = {
  description: 'A value, a list of values (any of), or {"not": value-or-list}.',
  anyOf: [
    { type: ["string", "boolean"] },
    { type: "array", items: { type: ["string", "boolean"] } },
    { type: "object", properties: { not: {} }, required: ["not"], additionalProperties: false },
  ],
};

/** `getRows` is called per request so the real/synthetic toggle applies immediately. */
export function readEvidenceTool(getRows: () => Evidence[]) {
  return tool(
    "read_evidence",
    `Query outreach evidence. Returns slice stats (n, humanReplies, positive, rejections, bounces, rate), optional per-group stats, and up to ${MAX_SAMPLE} sample rows with IDs. Cite row IDs as evidence.`,
    {
      type: "object",
      properties: {
        filter: {
          type: "object",
          description: `Field filters, AND-ed. Fields: ${FILTER_FIELDS.join(", ")}. Example: {"market":{"not":"IN"},"inbox_type":"named_person"}`,
          properties: Object.fromEntries(FILTER_FIELDS.map((f) => [f, fieldFilter])),
          additionalProperties: false,
        },
        window: {
          type: "object",
          description: "Inclusive sent_at range, YYYY-MM-DD.",
          properties: { from: { type: "string" }, to: { type: "string" } },
          additionalProperties: false,
        },
        groupBy: { type: "string", enum: [...FILTER_FIELDS] },
      },
      additionalProperties: false,
    },
    async (args: ReadEvidenceArgs) => JSON.stringify(readEvidence(getRows(), args)),
  );
}
