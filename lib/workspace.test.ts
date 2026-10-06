// workspaceState's provenance: each rule tied to the commit that wrote its wording, looking through undos.
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const tmp = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const root = mkdtempSync(join(tmpdir(), "rulebook-state-"));
  return { root, agent: join(root, "agent"), store: join(root, ".rulebook") };
});
vi.mock("./paths", () => ({ WORKSPACE: tmp.root, AGENT_DIR: tmp.agent, STORE_DIR: tmp.store }));

const { GitService } = await import("./git/GitService");
const { workspaceState } = await import("./workspace");

const setRule2 = (text: string) => readFileSync(join(tmp.agent, "RULES.md"), "utf8").replace(/- \[R-002\] .*/, `- [R-002] ${text}`);

beforeEach(() => {
  rmSync(tmp.root, { recursive: true, force: true });
  mkdirSync(tmp.root, { recursive: true });
  cpSync("agent-template", tmp.agent, { recursive: true });
});
afterAll(() => rmSync(tmp.root, { recursive: true, force: true }));

describe("workspaceState rule origins", () => {
  it("after an undo, a rule still points at the change that wrote its wording, marked as restored", async () => {
    const git = new GitService(tmp.agent);
    await git.init("init: rulebook v0 (July 2026 strategy)");
    const first = await git.commit({ "RULES.md": setRule2("Send to the careers@ inbox first.") }, "rule(R-002): modify — Send to the careers@ inbox first.", { N: "51", "Approved-By": "operator" });
    const second = await git.commit({ "RULES.md": setRule2("Send to the hr@ inbox first.") }, "rule(R-002): modify — Send to the hr@ inbox first.", { N: "1", "Approved-By": "operator" });
    await git.revert(second);

    const state = await workspaceState();
    const r2 = state.rules.find((r) => r.id === "R-002")!;
    expect(r2.text).toBe("Send to the careers@ inbox first.");
    expect(r2.origin).toMatchObject({ sha: first, n: 51, initial: false });
    expect(r2.origin?.restoredAt).toBeDefined();
    expect(state.rules.find((r) => r.id === "R-001")?.origin).toMatchObject({ initial: true });
  });
});
