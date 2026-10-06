// runPreflight with gitagent's query() faked: the model's answers are scripted, the slice, checks and git are real.
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GCMessage, GCToolDefinition, QueryOptions } from "@open-gitagent/gitagent";

const tmp = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const root = mkdtempSync(join(tmpdir(), "rulebook-preflight-"));
  return { root, agent: join(root, "agent"), store: join(root, ".rulebook") };
});
vi.mock("../paths", () => ({ WORKSPACE: tmp.root, AGENT_DIR: tmp.agent, STORE_DIR: tmp.store }));

/** Each model run: given the RULES.md it would see, return the submit_verdict args. */
let model: (rules: string, attempt: number) => Record<string, unknown>;
let runs = 0;
const prompts: string[] = [];
vi.mock("@open-gitagent/gitagent", async (importOriginal) => {
  const real = await importOriginal<typeof import("@open-gitagent/gitagent")>();
  return {
    ...real,
    query(opts: QueryOptions) {
      const attempt = runs++;
      prompts.push(String(opts.prompt));
      const rules = readFileSync(join(opts.dir!, "RULES.md"), "utf8");
      const run = (async () => {
        const t = opts.tools!.find((x: GCToolDefinition) => ["submit_verdict", "submit_answers", "submit_email"].includes(x.name))!;
        const out = await t.handler(model(rules, attempt)).catch((e: Error) => `error: ${e.message}`);
        const msgs: GCMessage[] = [
          { type: "tool_result", toolCallId: "1", toolName: t.name, content: String(out), isError: String(out).startsWith("error") },
          { type: "assistant", content: "done", model: "fake", provider: "fake", stopReason: "stop" },
        ];
        return msgs;
      })();
      return {
        async *[Symbol.asyncIterator]() {
          for (const m of await run) yield m;
        },
        costs: () => ({ totalCostUsd: 0.0005, totalInputTokens: 1, totalOutputTokens: 1, totalRequests: 1, startTime: 0, modelUsage: {} }),
      };
    },
  };
});

const { GitService } = await import("../git/GitService");
const { loadEvidence } = await import("../evidence");
const { computeSlice } = await import("../preflight");
const { draftEmail, readJobPost, runPreflight } = await import("./preflight");

const form = { location: "abroad", company: "startup", who: "hiring_manager", address: "guessed" } as const;
const slice = computeSlice(loadEvidence(), form);
const copy = { label: slice.label, n: slice.n, replies: slice.replies, bounces: slice.bounces, evidence_ids: [] };
const skip = (rule: string) => ({ verdict: "skip", headline: "Don't guess addresses abroad.", rule_ids: [rule], slice: copy, do_instead: "Use a published careers@ address.", basis: "rule" });
const noRule = { verdict: "no_rule", headline: "No rule covers this yet.", rule_ids: [], slice: copy, do_instead: "Find a published address first.", basis: "evidence_only" };

let git: InstanceType<typeof GitService>;
beforeEach(async () => {
  rmSync(tmp.root, { recursive: true, force: true });
  mkdirSync(tmp.root, { recursive: true });
  cpSync("agent-template", tmp.agent, { recursive: true });
  process.env.OPENAI_API_KEY = "test-not-real";
  runs = 0;
  prompts.length = 0;
  git = new GitService(tmp.agent);
  await git.init("init: rulebook v0 (July 2026 strategy)");
});
afterAll(() => rmSync(tmp.root, { recursive: true, force: true }));

describe("runPreflight", () => {
  it("rejects an answer whose numbers differ from the server's, and accepts the corrected retry", async () => {
    model = (_rules, attempt) => (attempt === 0 ? { ...skip("R-003"), slice: { ...copy, replies: 3 } } : skip("R-003"));
    const r = await runPreflight(form);
    expect(runs).toBe(2);
    expect(r).toMatchObject({ verdict: "skip", rule_ids: ["R-003"], slice: { n: slice.n, replies: slice.replies } });
    expect(r.slice.evidence_ids).toEqual(slice.evidence_ids);
  });

  it("gives up after the retry when the model keeps citing a rule that doesn't exist", async () => {
    model = () => skip("R-042");
    await expect(runPreflight(form)).rejects.toThrow(/rule_ids not in RULES.md: R-042/);
    expect(runs).toBe(2);
  });

  it("undoing a rule changes the next verdict for the same target", async () => {
    // The fake model follows whatever RULES.md it is given: skip if R-006 is there, otherwise no rule.
    model = (rules) => (rules.includes("[R-006]") ? skip("R-006") : noRule);
    const rules = readFileSync(join(tmp.agent, "RULES.md"), "utf8");
    const sha = await git.commit({ "RULES.md": `${rules.trimEnd()}\n- [R-006] Do not guess personal addresses at companies abroad.\n` }, "rule(R-006): add — Do not guess personal addresses at companies abroad.");

    expect((await runPreflight(form)).verdict).toBe("skip");
    await git.revert(sha);
    const after = await runPreflight(form);
    expect(after).toMatchObject({ verdict: "no_rule", rule_ids: [], tooFew: false, do_instead: "Find a published address first." });
  });

  it("passes a pasted job post to the verdict, so rules about the role can apply", async () => {
    model = () => skip("R-001");
    await runPreflight(form, { jobPost: "Junior QA tester, 1 year of experience, Berlin." });
    expect(prompts[0]).toContain("Junior QA tester, 1 year of experience, Berlin.");
  });
});

describe("readJobPost", () => {
  it("fills in only what the post makes clear; the rest stays for the operator", async () => {
    model = () => ({ location: "abroad", company: "startup", who: null, address: null, role: "Senior Full-Stack Engineer", company_name: "Lumora AI" });
    const r = await readJobPost("We are a 12-person AI startup in Berlin hiring a Senior Full-Stack Engineer. Apply via our careers page.");
    expect(r).toMatchObject({ location: "abroad", company: "startup", who: null, address: null, role: "Senior Full-Stack Engineer", company_name: "Lumora AI" });
    expect(prompts[0]).toContain("based in India");
  });

  it("refuses an answer outside the allowed options", async () => {
    model = () => ({ location: "mars", company: null, who: null, address: null, role: "Engineer", company_name: null });
    await expect(readJobPost("A long enough job post about an engineering role somewhere.")).rejects.toThrow(/Couldn't read the job post/);
  });
});

describe("draftEmail", () => {
  const note = (example_id: string | null) => ({ text: "Short opening, like an email that got an interested reply", rule_id: "R-003", example_id });
  const email = (example_id: string | null) => ({ to: "their published careers@ inbox", subject: "Senior Full-Stack Engineer", body: "Hi <company> team,\\n\\nI'm writing about the role.", notes: [note(example_id)] });

  it("learns from past emails that got replies, and rejects notes pointing at an email it wasn't shown", async () => {
    model = (_rules, attempt) => (attempt === 0 ? email("ev-999") : email(null));
    const r = await draftEmail(form, { verdict: "change", rule_ids: ["R-003"], do_instead: "Use the careers@ inbox." });
    expect(runs).toBe(2);
    expect(prompts[0]).toContain("got an INTERESTED reply");
    expect(prompts[1]).toContain("example_id not among the examples you were given: ev-999");
    expect(r).toMatchObject({ subject: "Senior Full-Stack Engineer", notes: [{ rule_id: "R-003" }] });
    expect(r.body).toBe("Hi <company> team,\n\nI'm writing about the role.");
    expect(r.examples.length).toBeGreaterThan(0);
  });
});
