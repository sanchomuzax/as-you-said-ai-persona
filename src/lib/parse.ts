export interface ParsedResponse {
  isValid: boolean
  abstained: boolean
  distribution: Record<string, number> | null
  topChoice: string | null
}

const invalid: ParsedResponse = { isValid: false, abstained: false, distribution: null, topChoice: null }

/**
 * Parse a Style C (distribution) model output.
 * Tolerates prose/code-fence wrapping; missing keys default to 0; normalizes to sum 1.
 * Invalid outputs are flagged, never dropped (invalid rate is itself a metric).
 */
export function parseDistribution(raw: string, keys: readonly string[]): ParsedResponse {
  const jsonText = extractFirstJsonObject(raw)
  if (!jsonText) return { ...invalid }

  let obj: unknown
  try {
    obj = JSON.parse(jsonText)
  } catch {
    return { ...invalid }
  }
  if (typeof obj !== 'object' || obj === null) return { ...invalid }
  const rec = obj as Record<string, unknown>

  if (rec['abstain'] === true) {
    return { isValid: true, abstained: true, distribution: null, topChoice: null }
  }

  const dist: Record<string, number> = {}
  let total = 0
  for (const key of keys) {
    const v = rec[key]
    const num = typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
    dist[key] = num
    total += num
  }
  if (total <= 0) return { ...invalid }

  const normalized = Object.fromEntries(keys.map((k) => [k, (dist[k] ?? 0) / total]))
  const topChoice = keys.reduce((best, k) =>
    (normalized[k] ?? 0) > (normalized[best] ?? 0) ? k : best
  )
  return { isValid: true, abstained: false, distribution: normalized, topChoice }
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}
