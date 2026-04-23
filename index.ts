import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { loadConfig } from "./config.js"
import {
  createState,
  resetState,
  createInputFingerprint,
} from "./state.js"
import { applyPruning } from "./pruner.js"

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
      }
    }
  })
  
  pi.on("session_shutdown", async (_event, _ctx) => {
    pi.appendEntry("dcp-state", {
      previousSummary: state.previousSummary,
      compressionCount: state.compressionCount,
      tokensSaved: state.tokensSaved,
      prunedToolIds: Array.from(state.prunedToolIds),
    })
  })
  
  pi.on("context", async (event, ctx) => {
    const prunedMessages = await applyPruning(event.messages, state, config, (ctx as any).apiClient)
    return { messages: prunedMessages }
  })
}
