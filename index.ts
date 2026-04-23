import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { loadConfig } from "./config.js"
import {
  createState,
  resetState,
  createInputFingerprint,
} from "./state.js"
import { applyPruning, generateHermesSummary } from "./pruner.js"

export default function (pi: ExtensionAPI) {
  const config = loadConfig(process.cwd())
  if (!config.enabled) return
  
  const state = createState()
  
  pi.on("tool_call", async (event, _ctx) => {
    if (!state.toolCalls.has(event.toolCallId)) {
      state.toolCalls.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        inputArgs: event.input as Record<string, unknown>,
        inputFingerprint: createInputFingerprint(
          event.toolName,
          event.input as Record<string, unknown>,
        ),
        isError: false,
        turnIndex: state.currentTurn,
        timestamp: 0,
        tokenEstimate: 0,
      })
    }
  })
  
  pi.on("tool_result", async (event, _ctx) => {
    const record = state.toolCalls.get(event.toolCallId)
    const outputText = event.content
      .map((c: any) => (c.type === "text" ? c.text : ""))
      .join("")
    const tokenEstimate = Math.round(outputText.length / 4)

    if (record) {
      record.isError = event.isError
      record.timestamp = Date.now()
      record.tokenEstimate = tokenEstimate
    } else {
      state.toolCalls.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        inputArgs: {},
        inputFingerprint: createInputFingerprint(event.toolName, {}),
        isError: event.isError,
        turnIndex: state.currentTurn,
        timestamp: Date.now(),
        tokenEstimate,
      })
    }
  })
  
  pi.on("session_start", async (event, ctx) => {
    resetState(state)
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === "dcp-state") {
        const data = entry.data as any
        if (data?.previousSummary) state.previousSummary = data.previousSummary
        if (data?.compressionCount) state.compressionCount = data.compressionCount
        if (data?.tokensSaved) state.tokensSaved = data.tokensSaved
        if (data?.prunedToolIds) state.prunedToolIds = new Set(data.prunedToolIds)
        if (data?.lastCompressionStatus) state.lastCompressionStatus = data.lastCompressionStatus
      }
    }
  })
  
  pi.on("session_shutdown", async (_event, _ctx) => {
    pi.appendEntry("dcp-state", {
      previousSummary: state.previousSummary,
      compressionCount: state.compressionCount,
      tokensSaved: state.tokensSaved,
      prunedToolIds: Array.from(state.prunedToolIds),
      lastCompressionStatus: state.lastCompressionStatus,
    })
  })

  pi.on("session_before_compact", async (event, ctx) => {
    try {
      const model = ctx.model
      if (!model) {
        const message = "Hermes compaction cancelled: no model selected."
        state.lastCompressionStatus = message
        ctx.ui.notify(message, "warning")
        return { cancel: true }
      }

      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
      if (!auth.ok) {
        const message = `Hermes compaction cancelled: ${auth.error}`
        state.lastCompressionStatus = message
        ctx.ui.notify(message, "warning")
        return { cancel: true }
      }

      const { preparation, signal } = event
      const messagesToSummarize = [
        ...preparation.messagesToSummarize,
        ...preparation.turnPrefixMessages,
      ]

      ctx.ui.notify(
        `Hermes compaction: summarizing ${messagesToSummarize.length} messages (${preparation.tokensBefore.toLocaleString()} tokens)...`,
        "info",
      )

      const result = await generateHermesSummary(
        messagesToSummarize,
        preparation.previousSummary ?? null,
        event.customInstructions ?? null,
        model,
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          signal,
          maxTokens: 8192,
        },
      )

      if (!result.ok || !result.summary) {
        if (!signal.aborted) {
          const message = `Hermes compaction cancelled: ${result.error ?? "empty summary"}`
          state.lastCompressionStatus = message
          ctx.ui.notify(message, "warning")
        }
        return { cancel: true }
      }

      state.previousSummary = result.summary
      state.lastCompressionStatus =
        `Hermes compaction ready: summarized ${messagesToSummarize.length} messages (${preparation.tokensBefore.toLocaleString()} tokens)`

      return {
        compaction: {
          summary: result.summary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          details: {
            kind: "hermes-middle",
            sweptToolOutputs: state.prunedToolIds.size,
          },
        },
      }
    } catch (error) {
      const message = `Hermes compaction cancelled: ${error instanceof Error ? error.message : String(error)}`
      state.lastCompressionStatus = message
      try {
        ctx.ui.notify(message, "warning")
      } catch {
        // Ignore UI failures; cancellation is the important safety behavior.
      }
      return { cancel: true }
    }
  })

  pi.on("session_compact", async (event, ctx) => {
    if (event.fromExtension) {
      state.compressionCount++
      state.lastCompressionStatus = "Hermes compaction completed"
      if (ctx.hasUI) ctx.ui.notify("Hermes compaction completed", "info")
    }
  })
  
  pi.on("context", async (event, ctx) => {
    const result = await applyPruning(event.messages, state, config)
    if (result.outcome) {
      state.lastCompressionStatus = result.outcome.message
    }
    return { messages: result.messages }
  })

  pi.registerCommand("acp", {
    description: "Auto-Compressor stats and manual trigger",
    async handler(args, ctx) {
      const argsStr = args.trim().toLowerCase();
      if (argsStr === "compress") {
        if (!ctx.isIdle()) {
          ctx.ui.notify("Manual Hermes compaction can only run between turns; the agent is currently running.", "warning");
          return;
        }
        if (ctx.hasPendingMessages()) {
          ctx.ui.notify("Manual Hermes compaction can only run when there are no queued messages.", "warning");
          return;
        }
        state.lastCompressionStatus = "Manual Hermes compaction started"
        ctx.ui.notify("Manual Hermes compaction started", "info")
        ctx.compact({
          onComplete: () => {
            state.lastCompressionStatus = "Manual Hermes compaction completed"
            ctx.ui.notify("Manual Hermes compaction completed", "info")
          },
          onError: (error) => {
            const message = `Manual Hermes compaction failed: ${error.message}`
            state.lastCompressionStatus = message
            ctx.ui.notify(message, "error")
          },
        })
        return;
      }
      
      const usage = ctx.getContextUsage ? ctx.getContextUsage() : null;
      let tokenStr = "unavailable";
      if (usage && usage.tokens !== null) {
        tokenStr = `${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()}`;
      }
      
      let totalToolTokens = 0;
      let prunedToolTokens = 0;
      
      for (const record of state.toolCalls.values()) {
        totalToolTokens += record.tokenEstimate || 0;
        if (state.prunedToolIds.has(record.toolCallId)) {
          prunedToolTokens += record.tokenEstimate || 0;
        }
      }
      
      const lines = [
        `Auto-Compressor (Hermes) Stats:`,
        `   Total Compressions: ${state.compressionCount}`,
        `   Pending Compression: No`,
        `   Tokens Saved (Compaction): ~${state.tokensSaved.toLocaleString()}`,
        `   Tokens Saved (Tool Pruning): ~${prunedToolTokens.toLocaleString()}`,
        `   Total Tool Calls Tracked: ${state.toolCalls.size}`,
        `   Swept Tool Outputs: ${state.prunedToolIds.size}`,
        `   Total Tool Tokens Generated: ~${totalToolTokens.toLocaleString()}`,
        `   Current User Turn: ${state.currentTurn}`,
        `   Summary Exists (Has Compressed): ${state.previousSummary !== null ? "Yes" : "No"}`,
        `   Last Compression Status: ${state.lastCompressionStatus ?? "None"}`,
        `   Current Context Tokens: ${tokenStr}`,
        "",
        "Type '/acp compress' between turns to run Hermes middle compaction."
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    }
  });
}
