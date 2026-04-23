import type { DcpState } from "./state.js"
import { type DcpConfig, AUTO_COMPRESS_CONFIG } from "./config.js"

const ALWAYS_PROTECTED_TOOLS = new Set(["compress", "write", "edit"]);

export interface PruningOutcome {
  kind: "compressed" | "skipped" | "failed"
  message: string
  tokensSaved?: number
}

export interface ApplyPruningResult {
  messages: any[]
  outcome?: PruningOutcome
}

export interface SummaryAuth {
  apiKey?: string
  headers?: Record<string, string>
  [key: string]: unknown
}

export interface SummaryResult {
  ok: boolean
  summary?: string
  error?: string
}

function isToolResultMessage(msg: any): boolean {
  return msg?.role === "toolResult" || msg?.role === "tool";
}

function getToolResultId(msg: any): string | undefined {
  return msg?.toolCallId || msg?.tool_call_id;
}

function getAssistantToolCalls(msg: any): any[] {
  const calls: any[] = [];

  if (Array.isArray(msg?.content)) {
    for (const block of msg.content) {
      if (block?.type === "toolCall") calls.push(block);
    }
  }

  if (Array.isArray(msg?.tool_calls)) {
    calls.push(...msg.tool_calls);
  }

  return calls;
}

function getToolCallId(call: any): string | undefined {
  return call?.id;
}

function getToolCallName(call: any): string {
  return call?.name || call?.function?.name || "?";
}

function getToolCallArgsText(call: any): string {
  const args = call?.arguments ?? call?.function?.arguments ?? "";
  return typeof args === "string" ? args : JSON.stringify(args);
}

function getMessageText(msg: any): string {
  const content = msg?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) => {
      if (typeof part?.text === "string") return part.text;
      if (typeof part?.thinking === "string") return part.thinking;
      return "";
    })
    .join("");
}

function getToolOutputChars(msg: any): number {
  return getMessageText(msg).length;
}

function textContent(text: string): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text }];
}

function prependTextContent(content: unknown, text: string): Array<any> {
  const prefix = { type: "text", text };
  if (Array.isArray(content)) return [prefix, ...content];
  if (typeof content === "string" && content.length > 0) {
    return [prefix, { type: "text", text: content }];
  }
  return [prefix];
}

function makeCompressionOutcome(
  originalCount: number,
  compressedCount: number,
  originalTokens: number,
  compressedTokens: number,
): PruningOutcome {
  const saved = originalTokens - compressedTokens;
  const delta = saved >= 0 ? `saved ~${saved.toLocaleString()} tokens` : `added ~${Math.abs(saved).toLocaleString()} tokens`;
  return {
    kind: "compressed",
    message: `compressed Hermes request context: ${originalCount} -> ${compressedCount} messages, ${delta}`,
    tokensSaved: saved,
  };
}

function markToolPruned(state: DcpState, id: string | undefined): void {
  if (!id || state.prunedToolIds.has(id)) return;
  state.prunedToolIds.add(id);
  state.totalPruneCount++;
}

export function estimateMessageTokens(msg: any): number {
  if (!msg) return 0;
  const content = msg.content;
  if (!content) return 0;
  
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === "object") {
        if (typeof part.text === "string") text += part.text;
        else if (typeof part.thinking === "string") text += part.thinking;
        else if (part.type === "image") text += "image";
        else if (part.type === "toolCall") text += getToolCallArgsText(part);
      }
    }
  }
  
  let tokens = Math.round(text.length / 4) + 10;
  
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      const args = getToolCallArgsText(tc);
      tokens += Math.round(args.length / 4);
    }
  }
  
  return tokens;
}

export function estimateMessagesTokens(messages: any[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

export function applyHermesMiddleLayout(
  messages: any[],
  state: DcpState,
): ApplyPruningResult {
  const layout = state.activeHermesLayout;
  if (!layout) return { messages };

  const summaryIdx = messages.findIndex((msg) => msg?.role === "compactionSummary");
  if (summaryIdx < 0) return { messages };

  const summaryMessage = messages[summaryIdx];
  const rawMessages = messages.filter((_, idx) => idx !== summaryIdx);
  const compactedMessageCount = Math.min(layout.compactedMessageCount, rawMessages.length);
  const headEnd = Math.min(layout.headMessageCount, compactedMessageCount);
  const tailStart = Math.max(headEnd, compactedMessageCount - layout.tailMessageCount);

  const shapedMessages = [
    ...rawMessages.slice(0, headEnd),
    summaryMessage,
    ...rawMessages.slice(tailStart),
  ];

  const originalTokens = estimateMessagesTokens(messages);
  const shapedTokens = estimateMessagesTokens(shapedMessages);
  const saved = originalTokens - shapedTokens;
  const delta = saved >= 0
    ? `saved ~${saved.toLocaleString()} tokens`
    : `added ~${Math.abs(saved).toLocaleString()} tokens`;

  return {
    messages: shapedMessages,
    outcome: {
      kind: "compressed",
      message: `Hermes middle layout: ${messages.length} -> ${shapedMessages.length} messages, ${delta}`,
      tokensSaved: saved,
    },
  };
}

function alignBoundaryForward(messages: any[], idx: number): number {
  while (idx < messages.length && isToolResultMessage(messages[idx])) {
    idx++;
  }
  return idx;
}

function alignBoundaryBackward(messages: any[], idx: number): number {
  if (idx <= 0 || idx >= messages.length) return idx;
  let check = idx - 1;
  while (check >= 0 && isToolResultMessage(messages[check])) {
    check--;
  }
  if (check >= 0 && messages[check]?.role === "assistant" && getAssistantToolCalls(messages[check]).length > 0) {
    idx = check;
  }
  return idx;
}

function findTailCutByTokens(
  messages: any[],
  headEnd: number,
  tokenBudget: number,
  charsPerToken: number = 4
): number {
  const n = messages.length;
  const minTail = Math.min(AUTO_COMPRESS_CONFIG.protectLastN, n - headEnd - 1);
  const softCeiling = Math.floor(tokenBudget * 1.5);
  let accumulated = 0;
  let cutIdx = n;

  for (let i = n - 1; i >= headEnd; i--) {
    const msgTokens = estimateMessageTokens(messages[i]);
    if (accumulated + msgTokens > softCeiling && (n - i) >= minTail) {
      break;
    }
    accumulated += msgTokens;
    cutIdx = i;
  }

  const fallbackCut = n - minTail;
  if (cutIdx > fallbackCut) cutIdx = fallbackCut;
  if (cutIdx <= headEnd) cutIdx = Math.max(fallbackCut, headEnd + 1);
  
  cutIdx = alignBoundaryBackward(messages, cutIdx);
  
  return Math.max(cutIdx, headEnd + 1);
}

function serializeForSummary(turns: any[]): string {
  const parts: string[] = [];
  for (const msg of turns) {
    const role = msg.role || "unknown";
    let content = "";
    
    if (typeof msg.content === "string") {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = msg.content
        .map((p: any) => p.text || p.thinking || "")
        .join("\n");
    }
    
    const MAX_CONTENT = 6000;
    const HEAD_KEEP = 4000;
    const TAIL_KEEP = 1500;
    if (content.length > MAX_CONTENT) {
      content = content.slice(0, HEAD_KEEP) + "\n...[truncated]...\n" + content.slice(-TAIL_KEEP);
    }
    
    if (isToolResultMessage(msg)) {
      const toolId = getToolResultId(msg) || "";
      parts.push(`[TOOL RESULT ${toolId}]: ${content}`);
    } else if (role === "assistant") {
      const toolCalls = getAssistantToolCalls(msg);
      if (toolCalls.length > 0) {
        const tcParts = toolCalls.map((tc: any) => {
          const name = getToolCallName(tc);
          const args = getToolCallArgsText(tc);
          const argsShort = args.length > 150 ? args.slice(0, 120) + "..." : args;
          return `  ${name}(${argsShort})`;
        });
        content += "\n[Tool calls:\n" + tcParts.join("\n") + "\n]";
      }
      parts.push(`[ASSISTANT]: ${content}`);
    } else {
      parts.push(`[${role.toUpperCase()}]: ${content}`);
    }
  }
  return parts.join("\n\n");
}

export async function generateHermesSummary(
  turns: any[],
  previousSummary: string | null,
  focusTopic: string | null,
  model: any,
  auth?: SummaryAuth,
): Promise<SummaryResult> {
  const contentToSummarize = serializeForSummary(turns);
  
  const summarizerPreamble = 
    "You are a summarization agent creating a context checkpoint. " +
    "Your output will be injected as reference material for a DIFFERENT " +
    "assistant that continues the conversation. " +
    "Do NOT respond to any questions or requests in the conversation — " +
    "only output the structured summary. " +
    "Do NOT include any preamble, greeting, or prefix.";

  const templateSections = `## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
[User preferences, coding style, constraints]

## Progress
### Done
[Completed work — file paths, commands, results]
### In Progress
[Work currently underway]
### Blocked
[Any blockers]

## Key Decisions
[Important technical decisions and why]

## Resolved Questions
[Questions already answered — include answers]

## Pending User Asks
[Questions NOT yet answered, or "None."]

## Relevant Files
[Files read, modified, created — brief note on each]

## Remaining Work
[What remains — framed as context, not instructions]

## Critical Context
[Exact values, error messages, config details that would be lost]

## Tools & Patterns
[Tools used and how they were used]`;

  let prompt: string;
  if (previousSummary) {
    prompt = `${summarizerPreamble}

You are updating a context compaction summary. A previous compaction produced the summary below. New conversation turns have occurred since then.

PREVIOUS SUMMARY:
${previousSummary}

NEW TURNS TO INCORPORATE:
${contentToSummarize}

Update the summary using this exact structure. PRESERVE all existing information that is still relevant. ADD new progress. Move items from "In Progress" to "Done". Move answered questions to "Resolved Questions".

${templateSections}`;
  } else {
    prompt = `${summarizerPreamble}

Create a structured handoff summary for a different assistant that will continue this conversation.

TURNS TO SUMMARIZE:
${contentToSummarize}

Use this exact structure:

${templateSections}`;
  }

  if (focusTopic) {
    prompt += `\n\nFOCUS TOPIC: "${focusTopic}"
Prioritize preserving all information related to the focus topic.`;
  }

  try {
    if (!model) return { ok: false, error: "no model available" };
    const piAi = await import("@mariozechner/pi-ai");
    const response = await piAi.complete(model, {
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }]
    }, auth);

    if (response.stopReason !== "stop") {
      return {
        ok: false,
        error: `summary generation stopped with ${response.stopReason}${response.errorMessage ? `: ${response.errorMessage}` : ""}`,
      };
    }

    let text = "";
    if (Array.isArray(response.content)) {
      text = response.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("");
    } else if (typeof (response as any).content === "string") {
      text = (response as any).content;
    }

    const summary = text.trim();
    return summary ? { ok: true, summary } : { ok: false, error: "summary generation returned empty text" };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("Summary generation failed:", e);
    return { ok: false, error };
  }
}

function sanitizeToolPairs(messages: any[]): any[] {
  const assistantToolIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const tc of getAssistantToolCalls(msg)) {
      const id = getToolCallId(tc);
      if (id) assistantToolIds.add(id);
    }
  }
  
  const resultToolIds = new Set<string>();
  for (const msg of messages) {
    if (!isToolResultMessage(msg)) continue;
    const id = getToolResultId(msg);
    if (id) resultToolIds.add(id);
  }
  
  const cleaned = messages.filter((msg) => {
    if (!isToolResultMessage(msg)) return true;
    const id = getToolResultId(msg);
    return !id || assistantToolIds.has(id);
  });
  
  for (const msg of cleaned) {
    if (msg.role !== "assistant") continue;
    if (Array.isArray(msg.content)) {
      msg.content = msg.content.filter((block: any) => {
        if (block?.type !== "toolCall") return true;
        const id = getToolCallId(block);
        return !id || resultToolIds.has(id);
      });
    }
    if (Array.isArray(msg.tool_calls)) {
      msg.tool_calls = msg.tool_calls.filter((tc: any) => {
        const id = getToolCallId(tc);
        return !id || resultToolIds.has(id);
      });
    }
  }
  
  return cleaned;
}

function applyDeduplication(messages: any[], state: DcpState, config: DcpConfig, sweepEnd: number): void {
  if (!config.strategies.deduplication.enabled) return;

  const protectedTools = new Set([
    ...ALWAYS_PROTECTED_TOOLS,
    ...(config.strategies.deduplication.protectedTools ?? []),
  ]);

  const fingerprintMap = new Map<string, string[]>();

  for (let i = AUTO_COMPRESS_CONFIG.protectFirstN; i < sweepEnd; i++) {
    const msg = messages[i];
    if (!isToolResultMessage(msg)) continue;
    const toolName: string = msg.toolName ?? "";
    if (protectedTools.has(toolName)) continue;
    if (getToolOutputChars(msg) < AUTO_COMPRESS_CONFIG.minToolOutputPruneChars) continue;

    const record = state.toolCalls.get(getToolResultId(msg) || "");
    if (!record) continue;

    const fp = record.inputFingerprint;
    if (!fingerprintMap.has(fp)) {
      fingerprintMap.set(fp, []);
    }
    const id = getToolResultId(msg);
    if (id) fingerprintMap.get(fp)!.push(id);
  }

  for (const [, ids] of fingerprintMap) {
    if (ids.length <= 1) continue;
    for (let i = 0; i < ids.length - 1; i++) {
      markToolPruned(state, ids[i]);
    }
  }
}

function applyErrorPurging(messages: any[], state: DcpState, config: DcpConfig, sweepEnd: number): void {
  if (!config.strategies.purgeErrors.enabled) return;

  const protectedTools = new Set([
    ...ALWAYS_PROTECTED_TOOLS,
    ...(config.strategies.purgeErrors.protectedTools ?? []),
  ]);
  const turnsThreshold = config.strategies.purgeErrors.turns ?? 3;

  for (let i = AUTO_COMPRESS_CONFIG.protectFirstN; i < sweepEnd; i++) {
    const msg = messages[i];
    if (!isToolResultMessage(msg)) continue;
    if (!msg.isError) continue;

    const toolName: string = msg.toolName ?? "";
    if (protectedTools.has(toolName)) continue;
    if (getToolOutputChars(msg) < AUTO_COMPRESS_CONFIG.minToolOutputPruneChars) continue;

    const id = getToolResultId(msg);
    const record = state.toolCalls.get(id || "");
    if (!record) continue;

    if (state.currentTurn - record.turnIndex >= turnsThreshold) {
      markToolPruned(state, id);
    }
  }
}

function applyOldToolOutputSweeping(messages: any[], state: DcpState, config: DcpConfig, sweepEnd: number): void {
  const protectedTools = new Set([
    ...ALWAYS_PROTECTED_TOOLS,
    ...(config.strategies.deduplication.protectedTools ?? []),
    ...(config.strategies.purgeErrors.protectedTools ?? []),
  ]);

  for (let i = AUTO_COMPRESS_CONFIG.protectFirstN; i < sweepEnd; i++) {
    const msg = messages[i];
    if (!isToolResultMessage(msg)) continue;
    if (protectedTools.has(msg.toolName ?? "")) continue;
    if (getToolOutputChars(msg) < AUTO_COMPRESS_CONFIG.minToolOutputPruneChars) continue;

    const id = getToolResultId(msg);
    markToolPruned(state, id);
  }
}

function applyToolOutputPruning(messages: any[], state: DcpState, sweepEnd: number): void {
  for (let i = AUTO_COMPRESS_CONFIG.protectFirstN; i < sweepEnd; i++) {
    const msg = messages[i];
    if (!isToolResultMessage(msg)) continue;
    const id = getToolResultId(msg);
    if (!state.prunedToolIds.has(id || "")) continue;
    const chars = getToolOutputChars(msg);
    const toolName = msg.toolName || "unknown";
    if (msg.isError) {
      msg.content = [{ type: "text", text: `[Tool output swept: ${toolName} ${id || ""}, error output, ${chars.toLocaleString()} chars removed]` }];
    } else {
      msg.content = [{ type: "text", text: `[Tool output swept: ${toolName} ${id || ""}, ${chars.toLocaleString()} chars removed]` }];
    }
  }
}

export async function applyPruning(
  messages: any[],
  state: DcpState,
  config: DcpConfig,
): Promise<ApplyPruningResult> {
  const msgs = messages.map((m: any) => {
    const clone = { ...m };
    if (Array.isArray(clone.content)) {
      clone.content = clone.content.map((b: any) => 
        typeof b === "object" && b !== null ? { ...b } : b
      );
    }
    return clone;
  });

  state.currentTurn = msgs.filter((m) => m.role === "user").length;

  const protectedTailStart = Math.max(
    AUTO_COMPRESS_CONFIG.protectFirstN,
    msgs.length - AUTO_COMPRESS_CONFIG.protectLastN,
  );

  applyOldToolOutputSweeping(msgs, state, config, protectedTailStart);
  applyDeduplication(msgs, state, config, protectedTailStart);
  applyErrorPurging(msgs, state, config, protectedTailStart);
  applyToolOutputPruning(msgs, state, protectedTailStart);

  return { messages: sanitizeToolPairs(msgs) };
}
