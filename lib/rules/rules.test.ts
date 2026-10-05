import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyProposal, cleanRuleText, nextRuleId, parseRules } from ".";

const v0 = readFileSync("agent-template/RULES.md", "utf8");

describe("parseRules", () => {
  it("reads the five v0 rules and ignores the title and comment", () => {
    const rules = parseRules(v0);
    expect(rules.map((r) => r.id)).toEqual(["R-001", "R-002", "R-003", "R-004", "R-005"]);
    expect(rules[2].text).toMatch(/^If no address is listed, guess the hiring manager's email/);
  });

  it("ignores lines that only look like rules", () => {
    expect(parseRules("- R-001 no brackets\n* [R-002] wrong bullet\n- [R-1] short id\n  - [R-003] indented ok")).toEqual([
      { id: "R-003", text: "indented ok" },
    ]);
  });
});

describe("nextRuleId", () => {
  it("is one past the highest ID ever seen, zero-padded", () => {
    expect(nextRuleId(["R-001", "R-005", "R-003"])).toBe("R-006");
    expect(nextRuleId([])).toBe("R-001");
    expect(nextRuleId(["R-099"])).toBe("R-100");
    expect(nextRuleId(["R-999"])).toBe("R-1000");
  });

  it("never reuses a retired ID when history is passed in", () => {
    const afterRetire = applyProposal(v0, { op: "retire", rule_id: "R-005" });
    const current = parseRules(afterRetire).map((r) => r.id);
    expect(nextRuleId(current)).toBe("R-005"); // why the caller must include history…
    expect(nextRuleId([...current, "R-005"])).toBe("R-006"); // …and with it, no reuse
  });

  it("ignores junk", () => {
    expect(nextRuleId(["P-010", "R-x", "R-002"])).toBe("R-003");
  });
});

describe("applyProposal", () => {
  it("add appends after the last rule and keeps everything else byte for byte", () => {
    const out = applyProposal(v0, { op: "add", rule_text: "Don't guess personal emails at foreign companies." }, "R-006");
    expect(out).toBe(v0.replace(
      "- [R-005] If there is no reply after ~10 days, send the same email again to the same address.",
      "- [R-005] If there is no reply after ~10 days, send the same email again to the same address.\n- [R-006] Don't guess personal emails at foreign companies.",
    ));
  });

  it("modify keeps the ID and line position", () => {
    const out = applyProposal(v0, { op: "modify", rule_id: "R-002", rule_text: "Prefer careers@ over info@." });
    expect(parseRules(out)[1]).toEqual({ id: "R-002", text: "Prefer careers@ over info@." });
    expect(out.split("\n").length).toBe(v0.split("\n").length);
  });

  it("retire removes only that line", () => {
    const out = applyProposal(v0, { op: "retire", rule_id: "R-003" });
    expect(parseRules(out).map((r) => r.id)).toEqual(["R-001", "R-002", "R-004", "R-005"]);
    expect(out.split("\n").length).toBe(v0.split("\n").length - 1);
  });

  it("adds to an empty rulebook", () => {
    expect(applyProposal("# Outreach Rulebook\n", { op: "add", rule_text: "Be brief." }, "R-001")).toBe("# Outreach Rulebook\n\n- [R-001] Be brief.\n");
  });

  it("flattens multi-line text and strips a smuggled ID so one proposal = one rule line", () => {
    const out = applyProposal(v0, { op: "add", rule_text: "- [R-001] Line one\n- [R-099] smuggled second rule" }, "R-006");
    const rules = parseRules(out);
    expect(rules).toHaveLength(6);
    expect(rules[5]).toEqual({ id: "R-006", text: "Line one - [R-099] smuggled second rule" });
  });

  it("rejects changes that don't apply", () => {
    expect(() => applyProposal(v0, { op: "modify", rule_id: "R-042", rule_text: "x x x x x" })).toThrow(/R-042 is not in the rulebook/);
    expect(() => applyProposal(v0, { op: "retire" })).toThrow(/not in the rulebook/);
    expect(() => applyProposal(v0, { op: "add", rule_text: "x" })).toThrow(/needs a new rule ID/);
    expect(() => applyProposal(v0, { op: "add", rule_text: "x" }, "R-003")).toThrow(/already exists/);
    expect(() => applyProposal(v0, { op: "add", rule_text: "   " }, "R-006")).toThrow(/needs rule_text/);
    expect(() => applyProposal(v0, { op: "modify", rule_id: "R-001" })).toThrow(/needs rule_text/);
  });
});

describe("cleanRuleText", () => {
  it("keeps normal text", () => {
    expect(cleanRuleText("  Prefer careers@ inboxes.  ")).toBe("Prefer careers@ inboxes.");
  });
});
