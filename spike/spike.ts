// M0 spike: prove gitagent query() + custom tool + preToolUse hook + memory commit work end to end.
// Run: npx tsx spike/spike.ts   (reads OPENAI_API_KEY from .env.local)
import { query, tool, type GCHooks } from "@open-gitagent/gitagent";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

process.loadEnvFile(".env.local");
if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is empty in .env.local");

const MODEL = process.env.RULEBOOK_MODEL || "openai:gpt-4o-mini";
const TIMEOUT_MS = Number(process.env.RULEBOOK_RUN_TIMEOUT_MS || 90_000);
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

const dir = mkdtempSync(join(tmpdir(), "rulebook-spike-"));
cpSync("agent-template", dir, { recursive: true });
git(dir, "init", "-q", "-b", "main");
git(dir, "add", "-A");
git(dir, "-c", "user.name=rulebook", "-c", "user.email=rulebook@local", "commit", "-q", "-m", "init: agent template");
console.log("agent dir:", dir);

const evidence = JSON.parse(readFileSync("data/evidence.real.json", "utf8")) as unknown[];
const echoEvidenceCount = tool(
  "echo_evidence_count",
  "Return how many evidence rows are loaded.",
  { type: "object", properties: {}, additionalProperties: false },
  async () => `evidence rows: ${evidence.length}`,
);

const sanitise = (s: string) => s.replace(/[^\w\s.,:()#/-]/g, "").slice(0, 120);
const hooks: GCHooks = {
  preToolUse: (ctx) => {
    console.log(`  [hook] ${ctx.toolName} args=${JSON.stringify(ctx.args)}`);
    if (["cli", "write", "edit"].includes(ctx.toolName)) return { action: "block", reason: `${ctx.toolName} is not allowed` };
    if (ctx.toolName === "memory" && typeof ctx.args.message === "string") {
      return { action: "modify", args: { ...ctx.args, message: `memory(spike): ${sanitise(ctx.args.message)}` } };
    }
    return { action: "allow" };
  },
};

async function run(label: string, prompt: string, extra: { maxTurns?: number; abortAfterFirstTool?: boolean; allowedTools?: string[] } = {}) {
  console.log(`\n=== ${label} ===`);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS); // our own wall-clock cap
  const q = query({
    dir, model: MODEL, prompt, hooks, abortController: ac, maxTurns: extra.maxTurns,
    tools: [echoEvidenceCount],
    allowedTools: extra.allowedTools ?? ["read", "memory", "echo_evidence_count"],
  });
  let assistantTurns = 0;
  for await (const m of q) {
    if (m.type === "delta") continue; // too noisy; counted below
    const detail =
      m.type === "assistant" ? `stop=${m.stopReason} text=${JSON.stringify(m.content.slice(0, 120))}` :
      m.type === "tool_use" ? `${m.toolName} ${JSON.stringify(m.args)}` :
      m.type === "tool_result" ? `${m.toolName} err=${m.isError} ${JSON.stringify(m.content.slice(0, 160))}` :
      m.type === "system" ? `${m.subtype}: ${m.content}` : m.content;
    console.log(`${m.type.padEnd(11)} ${detail}`);
    if (m.type === "assistant") assistantTurns++;
    if (m.type === "tool_use" && extra.abortAfterFirstTool) q.abort();
  }
  clearTimeout(timer);
  const types = q.messages().reduce<Record<string, number>>((a, m) => ((a[m.type] = (a[m.type] ?? 0) + 1), a), {});
  console.log("message types:", types, "assistant turns:", assistantTurns);
  console.log("costs:", JSON.stringify(q.costs()));
}

await run("main", "Call echo_evidence_count once. Then use the memory tool to save exactly one line: \"spike saw N evidence rows\" with N from the tool. Then also try the cli tool to run `ls`. Then stop.");
await run("maxTurns=1", "Call echo_evidence_count three times, one call per turn, then summarise.", { maxTurns: 1 });
// allowedTools hides cli from the model, so offer it here to prove the hook itself blocks it.
await run("hook blocks cli", "Use the cli tool to run `ls`, then stop.", { allowedTools: ["cli"] });
await run("abort after first tool_use", "Call echo_evidence_count, then read RULES.md, then summarise.", { abortAfterFirstTool: true });

console.log("\n=== git log --oneline ===\n" + git(dir, "log", "--oneline"));
console.log("=== memory/MEMORY.md ===\n" + readFileSync(join(dir, "memory/MEMORY.md"), "utf8"));
