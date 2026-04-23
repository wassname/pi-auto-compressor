# Fix Tool Output Pruning

## Goal
Prevent pi-auto-compressor from removing valid Pi tool results from the model context.

## Scope
In: Pi native assistant tool-call content blocks, tool-result pairing, token estimates, summary serialization, protected-tail tool sweeping, Hermes compaction override status.
Out: Changing compression thresholds or persistent session storage.

## Requirements
- R1: Preserve valid tool results. Done means: an assistant `content` block with `type: "toolCall"` and matching `toolResult.toolCallId` survives `applyPruning()`. VERIFY: focused script reports the matching tool result is present.
- R2: Preserve pair safety during compression. Done means: boundary alignment recognizes `toolResult` messages. VERIFY: TypeScript compiles and the helper paths use Pi message roles.
- R3: Keep legacy compatibility. Done means: existing OpenAI-style `tool_calls` fallback still works when present. VERIFY: helper handles both shapes.
- R4: Manual Hermes compaction runs through Pi's compaction lifecycle. Done means: `/acp compress` refuses active/queued runs, calls `ctx.compact()`, and `session_before_compact` supplies a custom Hermes `CompactionResult` or cancels. VERIFY: TypeScript compiles and subagent review finds no blocker.
- R5: Tool sweeping is simple and tail-safe. Done means: old, large tool outputs outside the protected tail are tombstoned while recent tail outputs are preserved. VERIFY: focused scripts show an old 250-char result is swept and a tail 250-char result is kept.

## Tasks
- [x] T1 (R1-R3): Patch `pruner.ts`.
  - verify: `npx tsc --noEmit`
  - success: no TypeScript errors.
  - likely_fail: tool result still filtered because assistant IDs are not collected.
  - sneaky_fail: assistant tool-call block is kept without a corresponding result after pruning.
- [x] T2 (R1): Run a focused regression script against `applyPruning()`.
  - verify: script prints preserved tool result count and content.
  - success: `toolResults=1` and output text is visible.
  - likely_fail: `toolResults=0`.
  - sneaky_fail: result exists but text is the pruning placeholder.
- [x] T3 (R4): Move Hermes compression into `session_before_compact`.
  - verify: `npx tsc --noEmit`; focused scripts for forced too-short and summary-failed paths.
  - success: `/acp compress` calls Pi compaction and the extension overrides it with Hermes summary.
  - likely_fail: hook returns nothing and Pi default compaction runs.
  - sneaky_fail: truncated/error summary is accepted as successful compaction.
- [x] T4 (R5): Add protected-tail tool sweeping.
  - verify: focused old-output and tail-output scripts.
  - success: old output prints a tombstone; tail output length remains 250.
  - likely_fail: recent tool output is swept.
  - sneaky_fail: swept tool result is deleted instead of tombstoned.

## Log
- Pi messages use assistant `content` blocks with `type: "toolCall"`; they do not use `msg.tool_calls` as the primary shape.
- `npx tsc --noEmit` passed.
- Regression script output: `toolResults=1`, `assistantCalls=1`, text `README.md\npruner.ts\n`.
- Hermes compaction now uses Pi's `session_before_compact` hook. The context hook only performs tool sweeping.
- The compaction override cancels on no model, auth failure, thrown errors, empty summaries, or non-`stop` summary responses; it does not intentionally fall back to Pi default compaction.
- Tool sweep script output: old 250-char `bash` result becomes `[Tool output swept: ...]`; protected-tail 250-char result remains length 250.
- Subagent review found and fixes addressed: reject truncated/error summary responses, avoid tombstoning currently protected-tail messages even when ID was previously marked, and wrap compaction hook with cancel-on-error.
