import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runLog } from "./runs";

let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "rulebook-runs-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("runLog", () => {
  it("starts at zero when nothing has run", () => {
    expect(runLog(dir).spend()).toMatchObject({ totalCostUsd: 0, runs: 0, budgetUsd: 5 });
  });

  it("adds up every run's cost and remembers the last one", () => {
    const log = runLog(dir);
    log.add({ kind: "analyst", status: "done", costUsd: 0.0083, proposalIds: ["P-001"], window: { from: "2026-07-12", to: "2026-07-31" } });
    log.add({ kind: "skeptic", status: "done", costUsd: 0.0012, proposalIds: ["P-001"] });
    const s = log.spend();
    expect(s.runs).toBe(2);
    expect(s.totalCostUsd).toBeCloseTo(0.0095, 6);
    expect(s.last).toMatchObject({ kind: "skeptic", costUsd: 0.0012 });
  });

  it("keeps the total when opened again, as after a page refresh or server restart", () => {
    runLog(dir).add({ kind: "analyst", status: "timeout", costUsd: 0.0004, proposalIds: [] });
    expect(runLog(dir).spend()).toMatchObject({ totalCostUsd: 0.0004, runs: 1 });
  });
});
