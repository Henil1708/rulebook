// One gitagent query() with our guard, turn cap, wall-clock timeout and client abort. Callers hold the lock.
import { query, type GCMessage, type GCToolDefinition, type SessionCosts } from "@open-gitagent/gitagent";
import { createGuard } from "./hooks";

export type AgentName = "analyst" | "skeptic";
export type RunStatus = "done" | "aborted" | "timeout" | "turn_limit" | "error";
export type OnEvent = (m: GCMessage, agent: AgentName) => void;

export interface AgentRunResult {
  status: RunStatus;
  error?: string;
  turns: number;
  costs: SessionCosts;
}

export const model = () => process.env.RULEBOOK_MODEL || "openai:gpt-4o-mini";
const timeoutMs = () => Number(process.env.RULEBOOK_RUN_TIMEOUT_MS || 90_000);

export async function runAgent(opts: {
  agent: AgentName;
  dir: string;
  prompt: string;
  tools: GCToolDefinition[];
  allowedTools: string[];
  maxTurns: number;
  signal?: AbortSignal;
  onEvent?: OnEvent;
}): Promise<AgentRunResult> {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
  const ac = new AbortController();
  const guard = createGuard({ agent: opts.agent, agentDir: opts.dir, allowedTools: opts.allowedTools, maxTurns: opts.maxTurns, abortController: ac });
  let timedOut = false;
  const timer = setTimeout(() => ((timedOut = true), ac.abort()), timeoutMs());
  const onClientAbort = () => ac.abort();
  if (opts.signal?.aborted) ac.abort();
  opts.signal?.addEventListener("abort", onClientAbort, { once: true });

  const q = query({
    dir: opts.dir,
    model: model(),
    prompt: opts.prompt,
    tools: opts.tools,
    allowedTools: opts.allowedTools,
    hooks: { preToolUse: guard.preToolUse },
    maxTurns: opts.maxTurns, // ignored by gitagent 2.2.0; the guard enforces it
    abortController: ac,
  });

  let error: string | undefined;
  try {
    for await (const m of q) {
      guard.onMessage(m);
      if (m.type === "system" && m.subtype === "error") error = m.content;
      opts.onEvent?.(m, opts.agent);
    }
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onClientAbort);
  }

  const status: RunStatus = timedOut
    ? "timeout"
    : opts.signal?.aborted
      ? "aborted"
      : guard.turns() >= opts.maxTurns && ac.signal.aborted
        ? "turn_limit"
        : error
          ? "error"
          : "done";
  return { status, ...(error ? { error } : {}), turns: guard.turns(), costs: q.costs() };
}
