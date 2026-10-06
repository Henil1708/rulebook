// Turns one finished agent step (tool + args + result) into a sentence saying what it found.
import type { Filter } from "@/lib/evidence";
import { groupLabel, pct, plural, ruleName } from "./format";

const BY: Record<string, string> = {
  inbox_type: "type of inbox",
  address_pattern: "how the address was found",
  company_stage: "company size",
  segment: "kind of company",
  market: "country",
  duplicate_of_earlier: "first email vs. follow-up",
  outcome: "result",
};
const VERDICT: Record<string, string> = { support: "Agrees", caution: "Unsure", oppose: "Disagrees" };

const parse = (s: string) => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

export function narrate(tool: string, args: Record<string, unknown> = {}, content: string, isError?: boolean): string | undefined {
  if (tool === "read_evidence") {
    const r = parse(content);
    if (!r?.stats) return isError ? "Tried to look at emails, but the request was wrong" : undefined;
    const filter = (r.query?.filter ?? {}) as Filter;
    const scope = Object.keys(filter).length ? `${plural(r.stats.n, "email")} ${groupLabel(filter)}` : `all ${r.stats.n} of your emails`;
    if (r.query?.groupBy) return `Compared ${scope === `all ${r.stats.n} of your emails` ? "your emails" : scope} by ${BY[r.query.groupBy] ?? String(r.query.groupBy).replace(/_/g, " ")}`;
    return `Looked at ${scope}: ${pct(r.stats.rate)} got a reply`;
  }
  if (tool === "read_rulebook") {
    const n = parse(content)?.rules?.length;
    return n ? `Read your ${n} rules` : "Read your rules";
  }
  if (tool === "memory") return "Checked what you turned down before";
  if (tool === "propose_rule_change") {
    const what = String(args.title ?? args.rule_text ?? "").slice(0, 80);
    const target = args.op === "add" ? "a new rule" : ruleName(String(args.rule_id ?? ""));
    if (isError || !/^Stored/.test(content)) return `Tried a suggestion for ${target}, but it didn't match the emails, so it was dropped`;
    return `Suggested for ${target}: "${what}"`;
  }
  if (tool === "submit_critique") {
    const v = VERDICT[String(args.verdict)];
    const overridden = /overridden/.test(content);
    return v ? `${overridden ? "Unsure (too few emails to agree)" : v}, ${pct(Number(args.adjusted_confidence ?? 0))} sure` : "Gave its opinion";
  }
  return undefined;
}

/** Merge runs of the same sentence: "Compared your emails by country" ×3 stays one line with a count. */
export function collapse<T extends { agent: string; text: string }>(steps: T[]): (T & { times: number })[] {
  const out: (T & { times: number })[] = [];
  for (const s of steps) {
    const last = out.at(-1);
    if (last && last.agent === s.agent && last.text === s.text) last.times++;
    else out.push({ ...s, times: 1 });
  }
  return out;
}
