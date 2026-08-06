import { describe, it, expect } from 'vitest'
import { loadPublicScript } from './helpers/load-public-script.js'

interface QuestionLike {
  positionConsistency?: number | null
  repetitionStability?: number | null
  abstainCount?: number
  invalidCount?: number
}

const api = loadPublicScript<{
  escapeHtml: (t: unknown) => string
  formatNumber: (n: unknown) => string
  formatMetric: (n: unknown) => string
  formatDateTime: (v: unknown) => string
  statusLabel: (s: string) => string
  statusTooltip: (s: string) => string
  renderMetricChips: (q: QuestionLike) => string
  runStatChips: (s: Record<string, number>) => string
  TOOLTIPS: Record<string, string>
}>(
  ['format.js', 'metrics.js'],
  '{ escapeHtml, formatNumber, formatMetric, formatDateTime, statusLabel, statusTooltip, renderMetricChips, runStatChips, TOOLTIPS }'
)

const { escapeHtml, formatNumber, formatMetric, formatDateTime, statusLabel, statusTooltip, renderMetricChips, runStatChips, TOOLTIPS } = api

describe('escapeHtml', () => {
  it('escapes every character that could break out of text or attribute context', () => {
    expect(escapeHtml('<b>&"\'')).toBe('&lt;b&gt;&amp;&quot;&#39;')
  })

  it('returns an empty string for null and undefined', () => {
    expect(escapeHtml(null)).toBe('')
    expect(escapeHtml(undefined)).toBe('')
  })
})

describe('formatters', () => {
  it('formats missing numbers defensively', () => {
    expect(formatNumber(null)).toBe('0')
    expect(formatMetric(null)).toBe('—')
    expect(formatMetric(0.666)).toBe('0.67')
  })

  it('reads SQLite timestamps as UTC, not as local time', () => {
    // 12:07 UTC is 14:07 in CEST — the naive Date() parse showed it two hours early.
    const formatted = formatDateTime('2026-08-06 12:07:20')
    expect(formatted).toBe(new Date('2026-08-06T12:07:20Z').toLocaleString('hu-HU'))
  })

  it('handles missing and unparseable timestamps', () => {
    expect(formatDateTime(null)).toBe('—')
    expect(formatDateTime('nem dátum')).toBe('nem dátum')
  })
})

describe('status labels', () => {
  it('translates known statuses and explains them in a tooltip', () => {
    expect(statusLabel('budget_exhausted')).toBe('Keret elfogyott')
    expect(statusTooltip('budget_exhausted')).toContain('token')
    expect(statusTooltip('paused')).not.toBe('')
  })

  it('falls back to the raw status when unknown', () => {
    expect(statusLabel('weird')).toBe('weird')
    expect(statusTooltip('weird')).toBe('')
  })
})

describe('runStatChips', () => {
  it('always shows progress, tokens and cost', () => {
    const html = runStatChips({ done: 4, totalCells: 8, invalid: 0, abstained: 0, totalTokens: 120, costUsd: 0.5 })
    expect(html).toContain('4/8 cella')
    expect(html).toContain('120 token')
    expect(html).toContain('0.5000 USD')
  })

  it('omits zero invalid and zero abstention chips', () => {
    const html = runStatChips({ done: 4, totalCells: 8, invalid: 0, abstained: 0, totalTokens: 0, costUsd: 0 })
    expect(html).not.toContain('Érvénytelen')
    expect(html).not.toContain('Tartózkodás')
  })

  it('labels abstention as tartózkodás — never as a rejection — and explains it', () => {
    const html = runStatChips({ done: 4, totalCells: 8, invalid: 2, abstained: 3, totalTokens: 0, costUsd: 0 })
    expect(html).toContain('Tartózkodás: 3')
    expect(html).not.toContain('Elutasít')
    expect(html).toContain(escapeHtml(TOOLTIPS.abstain))
    expect(html).toContain('Érvénytelen: 2')
  })

  it('adds the latency chip only when measured', () => {
    const base = { done: 1, totalCells: 1, invalid: 0, abstained: 0, totalTokens: 0, costUsd: 0 }
    // no exact digit grouping assertion: it is locale-data dependent (node vs browser ICU)
    expect(runStatChips({ ...base, avgLatencyMs: 1200 })).toContain('ms/válasz')
    expect(runStatChips(base)).not.toContain('ms/válasz')
  })
})

describe('renderMetricChips', () => {
  it('hides the abstention chip when there is nothing to report', () => {
    const html = renderMetricChips({ abstainCount: 0, invalidCount: 0 })
    expect(html).not.toContain('Tartózkodás')
    expect(html).not.toContain('Érvénytelen')
  })

  it('shows the abstention chip with its evidentiary-gap tooltip when non-zero', () => {
    const html = renderMetricChips({ abstainCount: 3 })
    expect(html).toContain('Tartózkodás: 3')
    expect(html).toContain(escapeHtml(TOOLTIPS.abstain))
  })

  it('shows the invalid chip only when non-zero', () => {
    expect(renderMetricChips({ invalidCount: 2 })).toContain('Érvénytelen: 2')
    expect(renderMetricChips({ invalidCount: 0 })).not.toContain('Érvénytelen')
  })

  it('adds tooltips to the PC and RS chips', () => {
    const html = renderMetricChips({ positionConsistency: 0.9, repetitionStability: 0.8 })
    expect(html).toContain('PC 0.90')
    expect(html).toContain('RS 0.80')
    expect(html).toContain(escapeHtml(TOOLTIPS.positionConsistency))
    expect(html).toContain(escapeHtml(TOOLTIPS.repetitionStability))
  })

  it('warns — with an explanation — when the result is position sensitive or unstable', () => {
    const html = renderMetricChips({ positionConsistency: 0.4, repetitionStability: 0.5 })
    expect(html).toContain('pozíció-érzékeny')
    expect(html).toContain(escapeHtml(TOOLTIPS.positionWarning))
    expect(html).toContain(escapeHtml(TOOLTIPS.stabilityWarning))
  })

  it('never emits an unescaped tooltip quote', () => {
    expect(runStatChips({ done: 1, totalCells: 2, invalid: 1, abstained: 1, totalTokens: 1, costUsd: 0 })).not.toMatch(
      /title="[^"]*"[^ =>]/
    )
    expect(renderMetricChips({ abstainCount: 1 })).not.toMatch(/title="[^"]*"[^ =>]/)
  })
})
