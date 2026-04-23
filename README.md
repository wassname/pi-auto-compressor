# Pi Auto-Compressor

A lightweight, invisible background extension for the Pi coding agent that automatically manages your context window using a Hermes-style "middle-slice" compression strategy.

## How it works (Hermes-Style)
Unlike Pi's built-in `/compact` command (which flattens your entire conversation history in the database), the Auto-Compressor runs entirely in the background during the `context` event before the LLM even sees the prompt.

When your context size exceeds the soft threshold (default 50% of max context window):
1. **Middle Slicing:** It safely carves out the "middle" of your conversation using token math, preserving the System Prompt (the head) and your most recent messages (the tail). It never splits `tool_call` and `tool_result` pairs.
2. **Background Summarization:** It passes that middle slice to a fast/cheap LLM (like Gemini Flash) to build a structured "Context Checkpoint" (Goals, Progress, Blockers, Key Decisions).
3. **Seamless Replacement:** It replaces the raw middle slice in the context window with the generated summary, preceded by a `[CONTEXT COMPACTION — REFERENCE ONLY]` tag.

The main agent never gets bogged down by huge logs, and your API calls stay cheap, but your full history remains intact in Pi's database!

## Built-in Sweeping
The extension also continuously sweeps tool outputs in the background:
- **Deduplication:** If a tool is called multiple times with the exact same arguments (e.g. `ls` or `cat` on the same file), it replaces older duplicate outputs with a small placeholder tombstone.
- **Error Purging:** If a tool fails, the error stays in context for a few turns so the agent can fix it, but is then purged to keep the context clean of dead failure traces.

## Commands
You don't *need* to use any commands—the extension runs automatically. However, if you want to inspect its behavior or trigger it manually, use the `/acp` command:

- `/acp` - Show stats on how many tokens have been saved, tools deduplicated, and whether a summary currently exists.
- `/acp compress` - Force a context compression on the next turn, regardless of token thresholds.

## Compatibility with `/compact`
This extension **does not conflict** with Pi's built-in `/compact` command.
- **`/compact`**: Destructively modifies your actual session branch in the database, squashing history into a single node.
- **Auto-Compressor**: Ephemeral modification of the context array sent to the API. It saves tokens dynamically without destroying your local branch history.
