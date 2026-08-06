/**
 * Single-choice options are mutually exclusive, so their probabilities form a
 * distribution summing to 1. Multi-choice options are independent: each carries
 * its own 0..1 selection probability and the sum is meaningless — normalizing
 * them would make every option look weaker the more options a question has.
 */
export type ElicitationMode = 'single_choice' | 'multi_choice'

/**
 * Multi-select questions need independent per-option probabilities; every other
 * scale type is a mutually exclusive single choice.
 */
export function elicitationModeFor(scaleType: string): ElicitationMode {
  return scaleType === 'multi_choice' ? 'multi_choice' : 'single_choice'
}

/** A multi-choice option counts as selected at or above this probability. */
export const SELECTION_THRESHOLD = 0.5

export interface ParsedResponse {
  isValid: boolean
  abstained: boolean
  distribution: Record<string, number> | null
  topChoice: string | null
  /** multi_choice only: every option at or above the selection threshold. */
  selectedKeys: string[] | null
}

const invalid: ParsedResponse = {
  isValid: false,
  abstained: false,
  distribution: null,
  topChoice: null,
  selectedKeys: null
}

/**
 * Parse a Style C (distribution) model output.
 * Tolerates prose/code-fence wrapping; missing keys default to 0.
 * Invalid outputs are flagged, never dropped (invalid rate is itself a metric).
 */
export function parseDistribution(
  raw: string,
  keys: readonly string[],
  mode: ElicitationMode = 'single_choice'
): ParsedResponse {
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
    return { isValid: true, abstained: true, distribution: null, topChoice: null, selectedKeys: null }
  }

  return mode === 'multi_choice' ? parseIndependent(rec, keys) : parseNormalized(rec, keys)
}

/** Accepts numbers and clean numeric strings; anything else is not an answer. */
function toProbability(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const num = Number(value)
    return Number.isFinite(num) ? num : null
  }
  return null
}

/** Mutually exclusive options: coerce to a distribution summing to 1. */
function parseNormalized(rec: Record<string, unknown>, keys: readonly string[]): ParsedResponse {
  const dist: Record<string, number> = {}
  let total = 0
  for (const key of keys) {
    const num = toProbability(rec[key])
    if (num !== null && num < 0) return { ...invalid }
    const value = num ?? 0
    dist[key] = value
    total += value
  }
  if (total <= 0) return { ...invalid }

  const normalized = Object.fromEntries(keys.map((k) => [k, (dist[k] ?? 0) / total]))
  const topChoice = keys.reduce((best, k) =>
    (normalized[k] ?? 0) > (normalized[best] ?? 0) ? k : best
  )
  return { isValid: true, abstained: false, distribution: normalized, topChoice, selectedKeys: null }
}

/**
 * Independent options: values are kept as-is. Out-of-range values are invalid
 * rather than rescaled — a model answering on a 0–100 scale did not do the task
 * we asked for, and silently rescaling would hide that in the invalid rate.
 * An all-zero answer is valid: "would select none of these" is a real answer.
 */
function parseIndependent(rec: Record<string, unknown>, keys: readonly string[]): ParsedResponse {
  const dist: Record<string, number> = {}
  let answered = 0
  for (const key of keys) {
    const v = rec[key]
    if (v === undefined || v === null) {
      dist[key] = 0
      continue
    }
    const num = toProbability(v)
    // 1 + epsilon: models emit 1.0000000001; anything genuinely above 1 (e.g. a
    // 0-100 answer) did not do the task we asked for and must count as invalid.
    if (num === null || num < 0 || num > 1 + 1e-9) return { ...invalid }
    dist[key] = Math.min(num, 1)
    answered++
  }
  // An object carrying none of our keys is not "selects none of them" — it is a
  // wrapper, an error message or a malformed abstention. Swallowing it here would
  // deflate the invalid rate and turn broken output into affirmative data.
  if (answered === 0) return { ...invalid }

  const selectedKeys = keys.filter((k) => (dist[k] ?? 0) >= SELECTION_THRESHOLD)
  const topChoice = keys.reduce((best, k) => ((dist[k] ?? 0) > (dist[best] ?? 0) ? k : best))
  return { isValid: true, abstained: false, distribution: dist, topChoice, selectedKeys: [...selectedKeys] }
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
