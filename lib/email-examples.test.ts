import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Evidence } from "./evidence";
import { loadBodies, pickExamples } from "./email-examples";

const row = (id: string, outcome: string, sent_at = "2026-07-12"): Evidence => ({ id, outcome, sent_at, company: `Co-${id}` }) as Evidence;

describe("pickExamples", () => {
  const rows = [row("a", "no_reply"), row("b", "reply_rejection"), row("c", "reply_positive"), row("d", "reply_positive"), row("e", "no_reply"), row("f", "reply_rejection")];
  const bodies = Object.fromEntries(rows.map((r) => [r.id, `body ${r.id}`]));

  it("takes replies first, interested ones on top and similar emails before others, then a couple without a reply", () => {
    const picked = pickExamples(rows, bodies, ["d", "f", "e"]);
    expect(picked.map((e) => e.id)).toEqual(["d", "c", "f", "e", "a"]);
  });

  it("only uses emails that have a body", () => {
    const some = Object.fromEntries(Object.entries(bodies).filter(([id]) => id !== "c" && id !== "d"));
    expect(pickExamples(rows, some, []).map((e) => e.id)).toEqual(["b", "f", "a", "e"]);
  });
});

describe("loadBodies", () => {
  it("prefers the operator's real bodies over the labelled samples", () => {
    const dir = mkdtempSync(join(tmpdir(), "rulebook-bodies-"));
    writeFileSync(join(dir, "email-bodies.synthetic.json"), JSON.stringify({ "ev-1": "sample" }));
    expect(loadBodies(dir)).toEqual({ bodies: { "ev-1": "sample" }, sample: true });
    writeFileSync(join(dir, "email-bodies.local.json"), JSON.stringify({ "ev-1": "real" }));
    expect(loadBodies(dir)).toEqual({ bodies: { "ev-1": "real" }, sample: false });
    rmSync(dir, { recursive: true, force: true });
  });
});
