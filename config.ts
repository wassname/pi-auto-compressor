export const AUTO_COMPRESS_CONFIG = {
  thresholdPercent: 0.50,      // compress when tokens > 50% of context window
  minimumContextLength: 64000, // never compress below this threshold
  protectFirstN: 3,            // messages: system prompt + first exchange
  protectLastN: 20,            // keep recent context intact
  summaryTargetRatio: 0.20,    // tail budget = threshold * 0.20
  charsPerToken: 4,            // rough estimate
  minToolOutputPruneChars: 200,
};

export interface DcpConfig {
  enabled: boolean
  debug: boolean
  strategies: {
    deduplication: {
      enabled: boolean
      protectedTools: string[]
    }
    purgeErrors: {
      enabled: boolean
      turns: number // prune error inputs after N user turns (default: 4)
      protectedTools: string[]
    }
  }
}

const DEFAULT_CONFIG: DcpConfig = {
  enabled: true,
  debug: false,
  strategies: {
    deduplication: {
      enabled: true,
      protectedTools: [],
    },
    purgeErrors: {
      enabled: true,
      turns: 4,
      protectedTools: [],
    },
  },
}

function deepMerge<T>(base: T, override: Partial<T>): T {
  if (override === null || override === undefined) return base
  if (typeof base !== "object" || typeof override !== "object") return override as T
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const key of Object.keys(override as Record<string, unknown>)) {
    const baseVal = (base as Record<string, unknown>)[key]
    const overVal = (override as Record<string, unknown>)[key]
    if (Array.isArray(baseVal) && Array.isArray(overVal)) {
      result[key] = [...new Set([...baseVal, ...overVal])]
    } else if (
      overVal !== null && typeof overVal === "object" && !Array.isArray(overVal) &&
      baseVal !== null && typeof baseVal === "object" && !Array.isArray(baseVal)
    ) {
      result[key] = deepMerge(baseVal as Record<string, unknown>, overVal as Record<string, unknown>)
    } else if (overVal !== undefined) {
      result[key] = overVal
    }
  }
  return result as T
}

export function loadConfig(projectDir: string): DcpConfig {
  return deepMerge(DEFAULT_CONFIG, {}) // Minimal implementation for simplicity
}
