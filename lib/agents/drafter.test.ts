// runDrafter with gitagent's query() faked: checks it reads RULES.md as it was at the ref, in a temp worktree.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GCMessage, GCToolDefinition, QueryOptions } from "@open-gitagent/gitagent";

const tmp = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const root = mkdtempSync(join(tmpdir(), "rulebook-drafter-"));
  return { root, agent: join(root, "agent"), store: join(root, ".rulebook") };
});
vi.mock("../paths", () => ({ WORKSPACE: tmp.root, AGENT_DIR: tmp.agent, STORE_DIR: tmp.store }));

const seen: { dir: string; rules: string }[] = [];
let submit: Record<string, unknown> = {};
vi.mock("@open-gitagent/gitagent", async (importOriginal) => {
  const real = await importOriginal<typeof import("@open-gitagent/gitagent")>();
  return {
    ...real,
    query(opts: QueryOptions) {
      seen.push({ dir: opts.dir!, rules: readFileSync(join(opts.dir!, "RULES.md"), "utf8") });
      const msgs: GCMessage[] = [];
      const run = (async () => {
        const t = opts.tools!.find((x: GCToolDefinition) => x.name === "submit_draft")!;
        const out = await t.handler(submit).catch((e: Error) => `error: ${e.message}`);
        msgs.push({ type: "tool_result", toolCallId: "1", toolName: "submit_draft", content: String(out), isError: false });
        msgs.push({ type: "assistant", content: "done", model: "fake", provider: "fake", stopReason: "stop" });
        return msgs;
      })();
      return {
        async *[Symbol.asyncIterator]() {
          for (const m of await run) yield m;
        },
        costs: () => ({ totalCostUsd: 0.001, totalInputTokens: 1, totalOutputTokens: 1, totalRequests: 1, startTime: 0, modelUsage: {} }),
      };
    },
  };
});

const { GitService } = await import("../git/GitService");
const { runDrafter } = await import("./drafter");

const target = { company: "XenonRaven", market: "IN", inbox_type: "careers_inbox" };
const draft = (cited: string[], body = "Hi team, I'm writing to the careers inbox (R-002) about the senior role.") => ({
  decision: "draft", to: "careers@", subject: "Senior full-stack engineer", body, cited_rules: cited,
});

beforeEach(async () => {
  rmSync(tmp.root, { recursive: true, force: true });
  mkdirSync(tmp.root, { recursive: true });
  cpSync("agent-template", tmp.agent, { recursive: true });
  process.env.OPENAI_API_KEY = "test-not-real";
  seen.length = 0;
  const git = new GitService(tmp.agent);
  await git.init("init: rulebook v0 (July 2026 strategy)");
  const rules = readFileSync(join(tmp.agent, "RULES.md"), "utf8").replace(/- \[R-002\] .*/, "- [R-002] Send to the careers@ inbox first.");
  await git.commit({ "RULES.md": rules }, "rule(R-002): modify — Send to the careers@ inbox first.");
});
afterAll(() => rmSync(tmp.root, { recursive: true, force: true }));

describe("runDrafter", () => {
  it("drafts with RULES.md as it was at the ref, in a worktree that is removed afterwards", async () => {
    submit = draft(["R-002"]);
    const v0 = await runDrafter(target, "v0");
    const now = await runDrafter(target, "HEAD");

    expect(seen[0].rules).not.toContain("Send to the careers@ inbox first.");
    expect(seen[1].rules).toContain("Send to the careers@ inbox first.");
    expect(v0.rules.find((r) => r.id === "R-002")?.text).not.toBe(now.rules.find((r) => r.id === "R-002")?.text);
    expect(now.draft).toMatchObject({ decision: "draft", to: "careers@", cited_rules: ["R-002"] });
    for (const s of seen) expect(existsSync(s.dir)).toBe(false);
    expect(await new GitService(tmp.agent).log()).toHaveLength(2); // drafting never commits
  });

  it("collects inline citations and refuses rule IDs that don't exist at that version", async () => {
    submit = draft([], "Writing to careers@ (R-002) with a tailored first line (R-004).");
    expect((await runDrafter(target, "HEAD")).draft?.cited_rules).toEqual(["R-002", "R-004"]);
    submit = draft(["R-002"], "Hi team,\\n\\nWriting to careers@ (R-002).");
    expect((await runDrafter(target, "HEAD")).draft?.body).toBe("Hi team,\n\nWriting to careers@ (R-002).");
    submit = draft(["R-099"]);
    expect((await runDrafter(target, "HEAD")).draft).toBeUndefined();
  });
});
