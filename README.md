# Pi Auto-Compressor

A lightweight, invisible background extension for the Pi coding agent that automatically manages your context window using a Hermes-style "middle-slice" compression strategy.

## Design References
- Hermes context compression and caching: https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching
- Pi extension API: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md

## How it works (Hermes-Style)
The Auto-Compressor uses Pi's extension hooks for two small jobs: lightweight request-context tool sweeping, and a custom Hermes-style implementation of Pi compaction. If Hermes compaction cannot produce a summary, compaction is cancelled rather than falling back to Pi's default summarizer.

When your context size exceeds the soft threshold (default 50% of max context window):
1. **Tool Sweeping:** It replaces old, large tool outputs outside the protected head/tail with tombstones while keeping tool result messages in place.
2. **Middle Slicing:** It overrides Pi compaction with a Hermes-style summary of the middle/old context while preserving Pi's recent-tail handling.
3. **Background Summarization:** It passes that middle slice to the active model to build a structured "Context Checkpoint" (Goals, Progress, Blockers, Key Decisions).
4. **Seamless Replacement:** Pi stores the custom Hermes summary as the compaction entry and reloads the session context safely.

The main agent never gets bogged down by huge logs, and your API calls stay cheap, but your full history remains intact in Pi's database!

## Built-in Sweeping
The extension also continuously sweeps tool outputs in the background:
- **Protected Tail:** Recent messages are left intact so the agent can still reason from fresh evidence.
- **Tombstones:** Old, large tool outputs are replaced with compact tombstones instead of deleting tool result messages.
- **Pair Safety:** Tool call/result pairs are sanitized so provider invariants stay valid.

## Commands
You don't *need* to use any commands—the extension runs automatically. However, if you want to inspect its behavior or trigger it manually, use the `/acp` command:

- `/acp` - Show stats on how many tokens have been saved, tool outputs swept, and whether a summary currently exists.
- `/acp compress` - Run Hermes middle compaction through Pi's compaction lifecycle. This can only run between turns and reports success or failure.

## Compatibility with `/compact`
This extension **does not conflict** with Pi's built-in `/compact` command.
- **`/compact`**: Destructively modifies your actual session branch in the database, squashing history into a single node.
- **Auto-Compressor**: Sweeps tool outputs ephemerally in request context, and overrides Pi compaction with a Hermes middle-summary when compaction runs.
