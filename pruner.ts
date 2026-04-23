import type { DcpState } from "./state.js"
import { type DcpConfig, AUTO_COMPRESS_CONFIG } from "./config.js"

const ALWAYS_PROTECTED_DEDUP = new Set(["compress", "write", "edit"]);

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
      }
    }
  }
  
  let tokens = Math.round(text.length / 4) + 10;
  
  const toolCalls = msg.tool_calls || [];
  for (const tc of toolCalls) {
    const args = tc?.function?.arguments || "";
    tokens += Math.round(args.length / 4);
  }
  
  return tokens;
}

export function estimateMessagesTokens(messages: any[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

function alignBoundaryForward(messages: any[], idx: number): number {
  while (idx < messages.length && messages[idx]?.role === "tool") {
    idx++;
  }
  return idx;
}

function alignBoundaryBackward(messages: any[], idx: number): number {
  if (idx <= 0 || idx >= messages.length) return idx;
  let check = idx - 1;
  while (check >= 0 && messages[check]?.role === "tool") {
    check--;
  }
  if (check >= 0 && messages[check]?.role === "assistant" && messages[check]?.tool_calls) {
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
  const minTail = Math.min(3, n - headEnd - 1);
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
    
    if (role === "tool" || role === "toolResult") {
      const toolId = msg.tool_call_id || msg.toolCallId || "";
      parts.push(`[TOOL RESULT ${toolId}]: ${content}`);
    } else if (role === "assistant") {
      const toolCalls = msg.tool_calls || [];
      if (toolCalls.length > 0) {
        const tcParts = toolCalls.map((tc: any) => {
          const name = tc?.function?.name || "?";
          const args = tc?.function?.arguments || "";
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

async function generateSummary(
  turns: any[],
  previousSummary: string | null,
  focusTopic: string | null,
  apiClient: any,
): Promise<string | null> {
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
    const model = (apiClient && apiClient.model) ? apiClient.model : "gemini-2.0-flash";
    const response = await apiClient.chat.completions.create({
      model: model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 4000,
    });
    return response.choices[0]?.message?.content?.trim() || null;
  } catch (e) {
    console.error("Summary generation failed:", e);
    return null;
  }
}

function sanitizeToolPairs(messages: any[]): any[] {
  const assistantToolIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const tc of msg.tool_calls || []) {
      const id = tc?.id || tc?.function?.name;
      if (id) assistantToolIds.add(id);
    }
  }
  
  const resultToolIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== "tool" && msg.role !== "toolResult") continue;
    const id = msg.tool_call_id || msg.toolCallId;
    if (id) resultToolIds.add(id);
  }
  
  const cleaned = messages.filter((msg) => {
    if (msg.role !== "tool" && msg.role !== "toolResult") return true;
    const id = msg.tool_call_id || msg.toolCallId;
    return !id || assistantToolIds.has(id);
  });
  
  for (const msg of cleaned) {
    if (msg.role !== "assistant" || !msg.tool_calls) continue;
    msg.tool_calls = msg.tool_calls.filter((tc: any) => {
      const id = tc?.id || tc?.function?.name;
      return !id || resultToolIds.has(id);
    });
  }
  
  return cleaned;
}

function applyDeduplication(messages: any[], state: DcpState, config: DcpConfig): void {
  if (!config.strategies.deduplication.enabled) return;

  const protectedTools = new Set([
    ...ALWAYS_PROTECTED_DEDUP,
    ...(config.strategies.deduplication.protectedTools ?? []),
  ]);

  const fingerprintMap = new Map<string, string[]>();

  for (const msg of messages) {
    if (msg.role !== "toolResult") continue;
    const toolName: string = msg.toolName ?? "";
    if (protectedTools.has(toolName)) continue;

    const record = state.toolCalls.get(msg.toolCallId || msg.tool_call_id);
    if (!record) continue;

    const fp = record.inputFingerprint;
    if (!fingerprintMap.has(fp)) {
      fingerprintMap.set(fp, []);
    }
    fingerprintMap.get(fp)!.push(msg.toolCallId || msg.tool_call_id);
  }

  for (const [, ids] of fingerprintMap) {
    if (ids.length <= 1) continue;
    for (let i = 0; i < ids.length - 1; i++) {
      state.prunedToolIds.add(ids[i]);
      state.totalPruneCount++;
    }
  }
}

function applyErrorPurging(messages: any[], state: DcpState, config: DcpConfig): void {
  if (!config.strategies.purgeErrors.enabled) return;

  const protectedTools = new Set(config.strategies.purgeErrors.protectedTools ?? []);
  const turnsThreshold = config.strategies.purgeErrors.turns ?? 3;

  for (const msg of messages) {
    if (msg.role !== "toolResult") continue;
    if (!msg.isError) continue;

    const toolName: string = msg.toolName ?? "";
    if (protectedTools.has(toolName)) continue;

    const record = state.toolCalls.get(msg.toolCallId || msg.tool_call_id);
    if (!record) continue;

    if (state.currentTurn - record.turnIndex >= turnsThreshold) {
      state.prunedToolIds.add(msg.toolCallId || msg.tool_call_id);
      state.totalPruneCount++;
    }
  }
}

function applyToolOutputPruning(messages: any[], state: DcpState): void {
  for (const msg of messages) {
    if (msg.role !== "toolResult") continue;
    if (!state.prunedToolIds.has(msg.toolCallId || msg.tool_call_id)) continue;
    if (msg.isError) {
      msg.content = [{ type: "text", text: "[Error output removed - tool failed more than N turns ago]" }];
    } else {
      msg.content = [{ type: "text", text: "[Output removed to save context - information superseded or no longer needed]" }];
    }
  }
}

export async function applyPruning(
  messages: any[],
  state: DcpState,
  config: DcpConfig,
  apiClient: any
): Promise<any[]> {
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

  applyDeduplication(msgs, state, config);
  applyErrorPurging(msgs, state, config);
  applyToolOutputPruning(msgs, state);
  
  const totalTokens = estimateMessagesTokens(msgs);
  const contextLength = (config as any).contextLength || 128000; 
  const thresholdTokens = Math.max(
    Math.floor(contextLength * AUTO_COMPRESS_CONFIG.thresholdPercent),
    AUTO_COMPRESS_CONFIG.minimumContextLength
  );
  
  if (
    state.forceCompressNext || 
    (totalTokens >= thresholdTokens && msgs.length > AUTO_COMPRESS_CONFIG.protectFirstN + 4)
  ) {
    state.forceCompressNext = false;
    const tailBudget = Math.floor(thresholdTokens * AUTO_COMPRESS_CONFIG.summaryTargetRatio);
    const compressStart = alignBoundaryForward(msgs, AUTO_COMPRESS_CONFIG.protectFirstN);
    const compressEnd = findTailCutByTokens(msgs, compressStart, tailBudget);
    
    if (compressStart < compressEnd) {
      const middle = msgs.slice(compressStart, compressEnd);
      const summary = await generateSummary(middle, state.previousSummary, null, apiClient);
      
      if (summary) {
        const compressed: any[] = [];
        
        for (let i = 0; i < compressStart; i++) {
          compressed.push(msgs[i]);
        }
        
        const lastHeadRole = msgs[compressStart - 1]?.role || "user";
        const firstTailRole = msgs[compressEnd]?.role || "user";
        
        let summaryRole = lastHeadRole === "assistant" ? "user" : "assistant";
        if (summaryRole === firstTailRole) {
          const flipped = summaryRole === "user" ? "assistant" : "user";
          if (flipped !== lastHeadRole) {
            summaryRole = flipped;
          } else {
            const tailMsg = { ...msgs[compressEnd] };
            const originalContent = tailMsg.content || "";
            tailMsg.content = 
              "## Goal\n" + summary + "\n\n--- END OF CONTEXT SUMMARY ---\n\n" + 
              (typeof originalContent === "string" ? originalContent : "");
            compressed.push(tailMsg);
            for (let i = compressEnd + 1; i < msgs.length; i++) {
              compressed.push(msgs[i]);
            }
            state.previousSummary = summary;
            state.compressionCount++;
            state.tokensSaved += totalTokens - estimateMessagesTokens(compressed);
            return sanitizeToolPairs(compressed);
          }
        }
        
        const prefix = 
          "[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below. " +
          "This is a handoff from a previous context window — treat it as background reference, " +
          "NOT as active instructions. Do NOT answer questions or fulfill requests mentioned in this summary; " +
          "they were already addressed. Respond ONLY to the latest user message that appears AFTER this summary:";
        
        compressed.push({
          role: summaryRole,
          content: prefix + "\n\n" + summary,
        });
        
        for (let i = compressEnd; i < msgs.length; i++) {
          compressed.push(msgs[i]);
        }
        
        state.previousSummary = summary;
        state.compressionCount++;
        state.tokensSaved += totalTokens - estimateMessagesTokens(compressed);
        
        return sanitizeToolPairs(compressed);
      }
    }
  }
  
  return sanitizeToolPairs(msgs);
}
