"use client";
// Runs the Analyst (then the Skeptic) and turns the SSE stream into run state + an activity log.
// EventSource can't POST, so the stream is read with fetch and parsed here.
import { useCallback, useRef, useState } from "react";
import type { AnalystResult } from "@/lib/agents/analyst";
import type { AgentName } from "@/lib/agents/run";
import { api } from "./api";
import { narrate } from "./narrate";

export interface ActivityEvent {
  id: number;
  at: number;
  agent: AgentName | "system";
  kind: "start" | "end" | "call" | "result" | "say" | "error" | "step";
  tool?: string;
  text: string;
  isError?: boolean;
}

export type RunState =
  | { phase: "idle" }
  | { phase: "running"; agent: AgentName; detail: string; startedAt: number }
  | { phase: "done"; result: AnalystResult }
  | { phase: "error"; code: "missing_key" | "busy" | "budget" | "timeout" | "not_initialised" | "network" | "failed" | "aborted"; message: string; result?: AnalystResult };

const short = (v: unknown, max = 140) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/** What the operator reads in the status line while a tool runs. */
export function describe(agent: AgentName, tool: string, args: Record<string, unknown> = {}): string {
  if (tool === "read_evidence") return agent === "skeptic" ? "The reviewer is reading the emails" : args.groupBy ? "The Analyst is comparing groups of emails" : "The Analyst is reading your results";
  if (tool === "read_rulebook") return "The Analyst is reading your rules";
  if (tool === "memory") return "The Analyst is checking what you dismissed before";
  if (tool === "propose_rule_change") return "The Analyst is writing a suggestion";
  if (tool === "submit_critique") return "The reviewer is giving its opinion";
  return `${agent === "skeptic" ? "Reviewer" : "Analyst"}: ${tool}`;
}

export function useRun(hooks: { onProposalStored: () => void; onFinished: (r?: AnalystResult) => void }) {
  const [run, setRun] = useState<RunState>({ phase: "idle" });
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const abort = useRef<AbortController | null>(null);
  const seq = useRef(0);
  const calls = useRef(new Map<string, Record<string, unknown>>());
  const hooksRef = useRef(hooks);
  hooksRef.current = hooks;

  const push = useCallback((e: Omit<ActivityEvent, "id" | "at">) => {
    setEvents((prev) => [...prev.slice(-400), { ...e, id: ++seq.current, at: Date.now() }]);
  }, []);

  const start = useCallback(
    async () => {
      const ac = new AbortController();
      abort.current = ac;
      setRun({ phase: "running", agent: "analyst", detail: "Starting the Analyst", startedAt: Date.now() });
      setEvents([]);
      push({ agent: "system", kind: "start", text: "Run started" });

      let res: Response;
      try {
        res = await api.runAnalyst(ac.signal);
      } catch (err) {
        const aborted = ac.signal.aborted;
        setRun({ phase: "error", code: aborted ? "aborted" : "network", message: aborted ? "Run stopped." : (err as Error).message });
        return;
      }
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        setRun({ phase: "error", code: body.code ?? "failed", message: body.error ?? `The run could not start (${res.status}).` });
        push({ agent: "system", kind: "error", text: body.error ?? `HTTP ${res.status}`, isError: true });
        return;
      }

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      let result: AnalystResult | undefined;
      let failure: string | undefined;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let cut: number;
          while ((cut = buffer.indexOf("\n\n")) !== -1) {
            const block = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const event = /^event: (.*)$/m.exec(block)?.[1];
            const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? "null");
            if (!event || event === "delta") continue;
            const agent: AgentName = data?.agent ?? "analyst";
            if (event === "system" && data.subtype === "session_start") {
              setRun((r) => (r.phase === "running" ? { ...r, agent, detail: agent === "skeptic" ? "The reviewer is checking a suggestion" : "The Analyst is reading your results" } : r));
              push({ agent, kind: "start", text: "started" });
            } else if (event === "system" && data.subtype === "error") {
              push({ agent, kind: "error", text: data.content, isError: true });
            } else if (event === "system" && data.subtype === "session_end") {
              push({ agent, kind: "end", text: "finished" });
            } else if (event === "tool_use") {
              setRun((r) => (r.phase === "running" ? { ...r, agent, detail: describe(agent, data.toolName, data.args ?? {}) } : r));
              calls.current.set(data.toolCallId, data.args ?? {});
              push({ agent, kind: "call", tool: data.toolName, text: short(data.args ?? {}) });
            } else if (event === "tool_result") {
              push({ agent, kind: "result", tool: data.toolName, text: short(data.content), isError: data.isError });
              const said = narrate(data.toolName, calls.current.get(data.toolCallId), String(data.content ?? ""), data.isError);
              if (said) push({ agent, kind: "step", tool: data.toolName, text: said });
              if (!data.isError && (data.toolName === "propose_rule_change" || data.toolName === "submit_critique")) hooksRef.current.onProposalStored();
            } else if (event === "assistant" && data.content) {
              push({ agent, kind: "say", text: short(data.content, 220) });
            } else if (event === "done") {
              result = data;
            } else if (event === "error") {
              failure = data.message;
            }
          }
        }
      } catch (err) {
        if (!ac.signal.aborted) failure = (err as Error).message;
      }

      abort.current = null;
      if (ac.signal.aborted) setRun({ phase: "error", code: "aborted", message: "Run stopped. Suggestions already found are kept." });
      else if (failure) setRun({ phase: "error", code: /OPENAI_API_KEY/.test(failure) ? "missing_key" : "failed", message: failure });
      else if (!result) setRun({ phase: "error", code: "failed", message: "The run ended without a result." });
      else if (result.status === "timeout") setRun({ phase: "error", code: "timeout", message: "The run stopped after 90 seconds. Suggestions already found are kept.", result });
      else if (result.status === "error") setRun({ phase: "error", code: "failed", message: result.error ?? "The model request failed.", result });
      else setRun({ phase: "done", result });
      const n = result?.proposalIds.length ?? 0;
      push({ agent: "system", kind: "end", text: result ? `${n ? `${n} new suggestion${n === 1 ? "" : "s"}` : "No new suggestions"}. Cost $${result.totalCostUsd.toFixed(3)}` : "Stopped before finishing" });
      hooksRef.current.onFinished(result);
    },
    [push],
  );

  const stop = useCallback(() => abort.current?.abort(), []);
  const dismiss = useCallback(() => setRun({ phase: "idle" }), []);
  const clear = useCallback(() => setEvents([]), []);

  return { run, events, start, stop, dismiss, clear };
}
