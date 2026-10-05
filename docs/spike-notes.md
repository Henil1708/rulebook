# M0 spike notes: gitagent SDK

Date: 2026-10-05 · Script: `spike/spike.ts` (`npx tsx spike/spike.ts`) · Model: `openai:gpt-4o-mini`

## Installed version
`@open-gitagent/gitagent@2.2.0` (npm `latest`). It brings in `@mariozechner/pi-agent-core` as the agent engine.

## What worked
- **Custom tool via `tool()`**: `echo_evidence_count` was called and returned `evidence rows: 142`.
- **`allowedTools`** filters tools *before* the model sees them. With `["read","memory","echo_evidence_count"]` the model never tried `cli`, even when the prompt told it to.
- **`preToolUse` block**: in a run that did offer `cli`, the hook blocked it. The model got
  `tool_result err=true "Tool \"cli\" blocked by hook: cli is not allowed"` and gave up politely.
- **`preToolUse` modify** on `memory`: the rewritten `message` reached git. The commit is
  `memory(spike): recorded the count of evidence rows observed`, so the prefix came from our hook, not the model.
- **Memory commit** lands in the agent dir's own repo:
  ```
  e2521d6 memory(spike): recorded the count of evidence rows observed
  95ab8d2 init: agent template
  ```
- **`abort()`** works. Aborting after the first `tool_use` ends the run with `assistant stop=aborted`, then `session_end`.
- **`q.costs()`** reports real numbers for OpenAI: `totalCostUsd`, tokens, requests, `cacheReadTokens`, and per-model usage. The whole spike (4 runs, about 13 requests) cost about **$0.002**.
- **Errors don't throw.** A failed LLM call arrives as `system error` plus `assistant stop=error`, then `session_end`. The UI should treat both as the error state.

## What differed from the docs / CLAUDE.md §5
- **`maxTurns` is NOT enforced** (CLAUDE.md §5/§6 says G8–G10 are fixed). With `maxTurns: 1`, the model made 3 tool calls over 4 assistant turns. `sdk.js` passes `maxTurns` into pi-agent-core's `initialState`, and the engine ignored it. `runtime.max_turns` in `agent.yaml` isn't read by the SDK path either.
  → We must cap turns ourselves: count `assistant` messages in the stream and call `q.abort()` (abort is proven to work), and keep the wall-clock timeout.
- **Message types**: there is also a `user` type (only for multi-turn prompts). The `system` subtypes seen were `session_start`, `session_end` and `error`. `delta` only appears when the model streams text; turns that are only tool calls emit none.
- **Several tool calls in one turn**: one assistant turn can emit more than one `tool_use`.
- **Memory tool shape**: `{ action: "save" | "load", content, message }`.
  - **`save` replaces the whole of `memory/MEMORY.md`.** It wiped the template's `# Memory` header.
  - Saving the same content twice gives `git commit failed: unknown error. The file was still written.` (nothing to commit), and the run carries on.
  - For storing rejections (M-later), the server should write memory commits through `GitService`, not let the Analyst overwrite the file.
- **`read` has no jail (G6 confirmed)**: the model called `read {"path":".."}` and `read {"path":"../.."}`. Those failed only because the paths are directories (`EISDIR`). A file path outside the agent dir would have been read.
  → `preToolUse` must also check the paths `read` is given (resolve the path, require it to be inside the agent dir).
- **The model wanders**: after doing the task it repeated `memory load` and browsed `..`. Tight prompts plus our own turn cap matter for the budget.

## Not verified
- **Sanitiser against a hostile `message`**: the model only sent clean messages. The vitest unit test for the sanitiser (M-later) has to cover injection strings.
- **Intermittent `403 … does not have access to model gpt-4o-mini`**: this showed up partway through runs right after the model was enabled in the OpenAI project's Limits page. It looks like the access change was still taking effect. Recheck before relying on it.
- **The package README**: I didn't compare against it. I worked from `dist/sdk-types.d.ts`, `dist/sdk.js` and observed behaviour.

## Ops notes
- The key belongs to the OpenAI project "AiResumeBuilder", which has **no spend limit** set. Consider a separate Rulebook project with a ~$5 cap.
