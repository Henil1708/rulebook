// One reusable guard per agent run: a preToolUse hook plus a turn counter for the stream.
// gitagent 2.2.0 doesn't enforce maxTurns, and built-in read/memory have no jail (docs/spike-notes.md).
import type { GCHookResult, GCMessage, GCPreToolUseContext } from "@open-gitagent/gitagent";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { sanitiseMessage } from "../git/message";

const ALWAYS_BLOCKED = new Set(["cli", "write", "edit"]);
const PATH_ARG = /path|file|dir|cwd/i;

export interface GuardOptions {
  agent: string;
  agentDir: string;
  allowedTools: string[];
  maxTurns: number;
  abortController: AbortController;
}

export interface Guard {
  preToolUse(ctx: Pick<GCPreToolUseContext, "toolName" | "args">): GCHookResult;
  /** Feed every streamed message; aborts the run once `maxTurns` assistant messages have arrived. */
  onMessage(m: GCMessage): void;
  turns(): number;
}

/** realpath of `p`, or of its deepest existing ancestor plus the rest, so a not-yet-existing file still resolves.
 *  A dangling symlink exists for lstat but makes realpath throw, which the guard turns into a block. */
function realish(p: string): string {
  if (lstatSync(p, { throwIfNoEntry: false })) return realpathSync(p);
  const parent = dirname(p);
  return parent === p ? p : join(realish(parent), basename(p));
}

/** True when `p` (relative to `root`, or absolute) resolves inside `root` after following symlinks. */
export function insideJail(root: string, p: string): boolean {
  const realRoot = realpathSync(root);
  const target = realish(isAbsolute(p) ? p : resolve(realRoot, p));
  return target === realRoot || target.startsWith(realRoot + sep);
}

export function createGuard(opts: GuardOptions): Guard {
  const allowed = new Set(opts.allowedTools);
  let turns = 0;
  const block = (reason: string): GCHookResult => ({ action: "block", reason });

  function preToolUse({ toolName, args }: Pick<GCPreToolUseContext, "toolName" | "args">): GCHookResult {
    try {
      if (ALWAYS_BLOCKED.has(toolName)) return block(`${toolName} is never allowed`);
      if (!allowed.has(toolName)) return block(`${toolName} is not in this agent's allowlist`);
      if (turns >= opts.maxTurns) return block(`turn limit (${opts.maxTurns}) reached`);
      if (toolName === "memory" && args?.action !== "load") return block("agents may only load memory; the server writes it");

      for (const [k, v] of Object.entries(args ?? {})) {
        if (PATH_ARG.test(k) && typeof v === "string" && !insideJail(opts.agentDir, v)) {
          return block(`${k} resolves outside the agent dir`);
        }
      }

      if (typeof args?.message === "string") {
        const message = `memory(${sanitiseMessage(opts.agent, 32)}): ${sanitiseMessage(args.message)}`;
        if (message !== args.message) return { action: "modify", args: { ...args, message } };
      }
      return { action: "allow" };
    } catch (err) {
      // Fail closed: anything unexpected (bad args, realpath errors) blocks the call.
      return block(`guard error: ${(err as Error).message}`);
    }
  }

  return {
    preToolUse,
    onMessage(m) {
      if (m.type === "assistant" && ++turns >= opts.maxTurns) opts.abortController.abort();
    },
    turns: () => turns,
  };
}
