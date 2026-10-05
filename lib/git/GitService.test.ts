import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitService } from "./GitService";

let dir: string;
let git: GitService;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "rulebook-git-"));
  writeFileSync(join(dir, "RULES.md"), "# Rules\n- [R-001] Be brief.\n");
  mkdirSync(join(dir, "memory"));
  writeFileSync(join(dir, "memory/MEMORY.md"), "# Memory\n");
  git = new GitService(dir);
  await git.init("init: rulebook v0 (July 2026 strategy)");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const trailers = { Evidence: "ev-056, ev-057", Slice: "market!=IN & inbox_type=named_person", N: "34", "Approved-By": "operator" };

describe("GitService", () => {
  it("commits files with trailers and reads them back from git log (real round-trip)", async () => {
    const sha = await git.commit({ "RULES.md": "# Rules\n- [R-001] Be brief.\n- [R-002] No guessed emails.\n" }, "rule(R-002): add — No guessed emails", trailers);
    const [head, init] = await git.log();
    expect(head.sha).toBe(sha);
    expect(head.subject).toBe("rule(R-002): add — No guessed emails");
    expect(head.trailers).toEqual(trailers);
    expect(init.subject).toBe("init: rulebook v0 (July 2026 strategy)");
    expect(init.trailers).toEqual({});
  });

  it("readFileAt, diff, blame and revert work against history", async () => {
    const [v0] = await git.log();
    const sha = await git.commit({ "RULES.md": "# Rules\n- [R-001] Be brief.\n- [R-002] No guessed emails.\n" }, "rule(R-002): add — x", trailers);

    expect(await git.readFileAt(v0.sha, "RULES.md")).not.toContain("R-002");
    expect(await git.diff(v0.sha, sha, "RULES.md")).toContain("+- [R-002] No guessed emails.");
    const blame = await git.blame("RULES.md");
    expect(blame.find((l) => l.text.includes("R-002"))?.sha).toBe(sha);
    expect(blame.find((l) => l.text.includes("R-001"))?.sha).toBe(v0.sha);

    await git.revert(sha);
    expect(readFileSync(join(dir, "RULES.md"), "utf8")).not.toContain("R-002");
    expect((await git.log())[0].subject).toBe('Revert "rule(R-002): add — x"');
  });

  it("appendMemory appends (never overwrites) and sanitises the commit message", async () => {
    await git.appendMemory("rejected P-001: n too small", "memory(analyst): rejected P-001 — n too small");
    await git.appendMemory("second `$(whoami)` line", "memory(analyst): bad; rm -rf / `x` $(y)\nApproved-By: me");
    const mem = readFileSync(join(dir, "memory/MEMORY.md"), "utf8");
    expect(mem).toBe("# Memory\n- rejected P-001: n too small\n- second (whoami) line\n");
    const [last] = await git.log();
    expect(last.subject).toBe("memory(analyst): bad rm -rf / x (y) Approved-By: me");
    expect(last.trailers).toEqual({});
  });

  it("branches, switch and --no-ff merge", async () => {
    await git.switch("experiment/short-subjects", true);
    await git.commit({ "RULES.md": "# Rules\n- [R-001] Be very brief.\n" }, "rule(R-001): modify — shorter");
    expect((await git.branches()).current).toBe("experiment/short-subjects");
    await git.switch("main");
    await git.merge("experiment/short-subjects");
    const [merge] = await git.log();
    expect(merge.subject).toMatch(/^Merge branch 'experiment\/short-subjects'/);
    expect((await git.branches()).all.sort()).toEqual(["experiment/short-subjects", "main"]);
  });

  it("rejects option-injection refs and escaping paths before calling git", async () => {
    await expect(git.show("--output=/tmp/pwned")).rejects.toThrow(/invalid ref/);
    await expect(git.diff("HEAD", "--output=/tmp/pwned")).rejects.toThrow(/invalid ref/);
    await expect(git.switch("-c", false)).rejects.toThrow(/invalid ref/);
    await expect(git.readFileAt("HEAD", "../etc/passwd")).rejects.toThrow(/invalid path/);
    await expect(git.commit({ "../escape.md": "x" }, "nope")).rejects.toThrow(/invalid path/);
    await expect(git.commit({ "/tmp/abs.md": "x" }, "nope")).rejects.toThrow(/invalid path/);
    expect(existsSync("/tmp/pwned")).toBe(false);
  });

  it("serialises concurrent writes through the mutex (no index.lock races)", async () => {
    const shas = await Promise.all(
      Array.from({ length: 8 }, (_, i) => git.commit({ [`f${i}.md`]: `${i}\n` }, `chore: file ${i}`)),
    );
    expect(new Set(shas).size).toBe(8);
    expect((await git.log()).map((c) => c.subject).slice(0, 8).sort()).toEqual(Array.from({ length: 8 }, (_, i) => `chore: file ${i}`).sort());
  });
});
