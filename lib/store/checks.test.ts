import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EmailResult, PreflightResult } from "../agents/preflight";
import { checkStore } from "./checks";

const dirs: string[] = [];
const store = () => {
  const d = mkdtempSync(join(tmpdir(), "rulebook-checks-"));
  dirs.push(d);
  return checkStore(d);
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const verdict = { verdict: "go", headline: "Send it." } as PreflightResult;
const email = (subject: string) => ({ subject }) as EmailResult;
const form = { location: "abroad", company: "startup", who: "careers_inbox", address: "published" } as const;

describe("checkStore", () => {
  it("keeps every check and every email version, newest check first in the summaries", () => {
    const s = store();
    const a = s.add({ form, verdict, role: "Senior Full-Stack Engineer", company: "Lumora AI", rulesSha: "abc" });
    s.add({ form, verdict });
    s.addEmail(a.id, email("v1"));
    s.addEmail(a.id, email("v2"));

    expect(s.get(a.id)?.emails.map((e) => e.subject)).toEqual(["v1", "v2"]);
    expect(s.summaries().map((c) => [c.id, c.emails])).toEqual([["C-002", 0], ["C-001", 2]]);
    expect(s.summaries()[1]).toMatchObject({ role: "Senior Full-Stack Engineer", company: "Lumora AI", verdict: "go", headline: "Send it." });
  });
});
