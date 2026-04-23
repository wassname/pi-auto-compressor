export interface ToolRecord {
  toolCallId: string
  toolName: string
  inputArgs: Record<string, unknown>
  inputFingerprint: string
  isError: boolean
  turnIndex: number
  timestamp: number
  tokenEstimate: number
}

export interface DcpState {
  toolCalls: Map<string, ToolRecord>
  prunedToolIds: Set<string>
  currentTurn: number
  tokensSaved: number
  totalPruneCount: number
  previousSummary: string | null
  compressionCount: number
}

export function createState(): DcpState {
  return {
    toolCalls: new Map(),
    prunedToolIds: new Set(),
    currentTurn: 0,
    tokensSaved: 0,
    totalPruneCount: 0,
    previousSummary: null,
    compressionCount: 0,
  }
}

export function resetState(state: DcpState): void {
  state.toolCalls.clear()
  state.prunedToolIds.clear()
  state.currentTurn = 0
  state.tokensSaved = 0
  state.totalPruneCount = 0
  state.previousSummary = null
  state.compressionCount = 0
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys)
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortObjectKeys(obj[key])
    }
    return sorted
  }
  return value
}

export function createInputFingerprint(toolName: string, args: Record<string, unknown>): string {
  const sorted = sortObjectKeys(args)
  return `${toolName}::${JSON.stringify(sorted)}`
}
