// runAnalyst → proposals → Skeptic on each, with gitagent's query() replaced by a scripted fake.
// Exercises the real tools, guard, store and ordering without calling a model.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GCMessage, GCToolDefinition, QueryOptions } from "@open-gitagent/gitagent";
import { filterEvidence, loadEvidence, sliceStats, type Filter } from "../evidence";

const tmp = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const root = mkdtempSync(join(tmpdir(), "rulebook-pipeline-"));
  return { root, agent: join(root, "agent"), store: join(root, ".rulebook") };
});
vi.mock("../paths", () => ({ WORKSPACE: tmp.root, AGENT_DIR: tmp.agent, STORE_DIR: tmp.store }));

type Script = (call: (name: string, args: unknown) => Promise<string>, opts: QueryOptions) => Promise<void>;
const script: { analyst: Script; skeptic: Script } = { analyst: async () => {}, skeptic: async () => {} };
const order: string[] = [];

vi.mock("@open-gitagent/gitagent", async (importOriginal) => {
  const real = await importOriginal<typeof import("@open-gitagent/gitagent")>();
  return {
    ...real,
    query(opts: QueryOptions) {
      const agent = opts.dir!.endsWith("skeptic") ? "skeptic" : "analyst";
      const msgs: GCMessage[] = [];
      const call = async (name: string, args: unknown) => {
        const hook = opts.hooks!.preToolUse!({ sessionId: "s", agentName: agent, event: "PreToolUse", toolName: name, args: args as Record<string, unknown> }) as { action: string; reason?: string };
        msgs.push({ type: "tool_use", toolCallId: name, toolName: name, args: args as Record<string, unknown> });
        if (hook.action === "block") return `blocked: ${hook.reason}`;
        const t = opts.tools!.find((x: GCToolDefinition) => x.name === name)!;
        try {
          return String(await t.handler(args));
        } catch (err) {
          return `error: ${(err as Error).message}`;
        }
      };
      const run = (async () => {
        order.push(agent === "skeptic" ? `skeptic:${/proposal (P-\d+)/.exec(opts.tools!.find((t) => t.name === "submit_critique")!.description)![1]}` : "analyst");
        await script[agent](call, opts);
        msgs.push({ type: "assistant", content: "done", model: "fake", provider: "fake", stopReason: "stop" });
        return msgs;
      })();
      return {
        async *[Symbol.asyncIterator]() {
          for (const m of await run) yield m;
        },
        costs: () => ({ totalCostUsd: 0.001, totalInputTokens: 10, totalOutputTokens: 5, totalRequests: 1, startTime: 0, modelUsage: {} }),
      };
    },
  };
});

const { runAnalyst } = await import("./analyst");
const { runSkeptic } = await import("./skeptic");
const { proposalStore } = await import("../store/proposals");

const window = { from: "2026-07-12", to: "2026-07-31" };
const july = filterEvidence(loadEvidence(), {}, window);
const slice = (filter: Filter) => {
  const s = sliceStats(july, filter);
  return { filter, n: s.n, ids: s.rows.slice(0, 2).map((r) => r.id) };
};
const small = slice({ market: "UK", inbox_type: "careers_inbox" });
const big = slice({ market: { not: "IN" }, inbox_type: "named_person" });
const propose = (s: ReturnType<typeof slice>, text: string) => ({
  op: "add", rule_text: text, evidence_ids: s.ids, slice: s.filter, n: s.n, metric: "see the slice", rationale: "because the data says so", confidence: 0.9,
});
const critique = (verdict = "support") => ({ verdict, adjusted_confidence: 0.6, concerns: ["one send day dominates"], what_would_change_my_mind: "more sends in this slice" });

beforeEach(() => {
  rmSync(tmp.root, { recursive: true, force: true });
  mkdirSync(tmp.root, { recursive: true });
  cpSync("agent-template", tmp.agent, { recursive: true });
  order.length = 0;
  process.env.OPENAI_API_KEY = "test-not-real";
  script.analyst = async (call) => {
    await call("read_evidence", {});
    await call("propose_rule_change", propose(small, "Email careers inboxes at UK companies first."));
    await call("propose_rule_change", propose(big, "Do not guess personal emails at foreign companies."));
  };
  script.skeptic = async (call) => void (await call("submit_critique", critique()));
});
afterAll(() => rmSync(tmp.root, { recursive: true, force: true }));

describe("Analyst → Skeptic pipeline", () => {
  it("the fixture slices sit on either side of the threshold", () => {
    expect(small.n).toBeGreaterThan(0);
    expect(small.n).toBeLessThan(10);
    expect(big.n).toBeGreaterThanOrEqual(10);
  });

  it("runs the Skeptic after the Analyst, once per proposal, in order", async () => {
    const result = await runAnalyst({ window });
    expect(result.proposalIds).toEqual(["P-001", "P-002"]);
    expect(order).toEqual(["analyst", "skeptic:P-001", "skeptic:P-002"]);
    expect(result.skeptic.map((s) => [s.proposalId, s.status])).toEqual([["P-001", "done"], ["P-002", "done"]]);
    expect(result.totalCostUsd).toBeCloseTo(0.003);
  });

  it("code overrides 'support' on the small slice and leaves the big one alone", async () => {
    await runAnalyst({ window });
    const store = proposalStore(tmp.store);
    expect(store.get("P-001")?.critique).toMatchObject({
      verdict: "caution",
      override: { model_verdict: "support", reason: `n=${small.n} is below 10: support is not allowed, downgraded to caution` },
    });
    expect(store.get("P-002")?.critique).toMatchObject({ verdict: "support" });
    expect(store.get("P-002")?.critique).not.toHaveProperty("override");
  });

  it("tags streamed events with the agent that produced them", async () => {
    const seen: string[] = [];
    await runAnalyst({ window, onEvent: (m, agent) => m.type === "tool_use" && seen.push(`${agent}:${m.toolName}`) });
    expect(seen).toEqual([
      "analyst:read_evidence", "analyst:propose_rule_change", "analyst:propose_rule_change",
      "skeptic:submit_critique", "skeptic:submit_critique",
    ]);
  });

  it("records critique_error when the Skeptic never submits, and carries on", async () => {
    let first = true;
    script.skeptic = async (call) => {
      if (first) return void (first = false); // P-001: says nothing
      await call("submit_critique", critique("oppose"));
    };
    const result = await runAnalyst({ window });
    const store = proposalStore(tmp.store);
    expect(store.get("P-001")?.critique).toBeUndefined();
    expect(store.get("P-001")?.critique_error).toMatch(/did not submit a critique \(done\)/);
    expect(store.get("P-002")?.critique?.verdict).toBe("oppose");
    expect(result.skeptic).toHaveLength(2);
  });

  it("the Skeptic can't use other tools", async () => {
    let reply = "";
    script.skeptic = async (call) => {
      reply = await call("propose_rule_change", propose(big, "Sneaky extra rule from the skeptic."));
      await call("submit_critique", critique());
    };
    await runAnalyst({ window });
    expect(reply).toMatch(/^blocked: propose_rule_change is not in this agent's allowlist/);
    expect(proposalStore(tmp.store).list()).toHaveLength(2);
  });

  it("critique: false skips the Skeptic; runSkeptic critiques one proposal later", async () => {
    const result = await runAnalyst({ window, critique: false });
    expect(result.skeptic).toEqual([]);
    expect(order).toEqual(["analyst"]);
    const s = await runSkeptic("P-001");
    expect(s.critique?.verdict).toBe("caution");
    expect(order).toEqual(["analyst", "skeptic:P-001"]);
  });
});

