import { describe, it, expect } from 'vitest'
import { loadPublicScript } from './helpers/load-public-script.js'

interface QuestionLike {
  elicitationMode?: string
  legacyElicitationCount?: number
  /** Control-arm counterpart of legacyElicitationCount (issue #40 review HIGH). */
  legacyElicitationBaselineCount?: number
  positionConsistency?: number | null
  repetitionStability?: number | null
  positionShift?: number | null
  positionShiftSampleSize?: number
  abstainCount?: number
  invalidCount?: number
  /** Present on the real API payload; used to tell a baseline-only (calibration)
   *  question apart from a persona-bearing one — same shape renderBaselineOnlyNotice
   *  already reads (issue #40 review HIGH/B). */
  byPersona?: Record<string, unknown>
  baseline?: number[] | null
}

interface ResponseLike {
  model_version?: string
  provider?: string
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
  renderLegacyOnlyNotice: (q: { legacyElicitationCount?: number; aggregatedResponseCount?: number }) => string
  renderBaselineOnlyNotice: (q: { byPersona?: Record<string, unknown>; baseline?: number[] | null }) => string
  renderCacheChip: (stats: { cachedTokens?: number; promptTokens?: number }) => string
  renderPartialEvaluationChip: (evaluation: {
    run_status?: string
    // SQLite hands back NULL for an unset column — the chip must survive that
    done_cells?: number | null
    total_cells?: number | null
  }) => string
  renderModelCell: (response: ResponseLike) => string
  renderProviderChip: (providers: { provider: string; count: number }[]) => string
  renderDuplicateNotice: (results: Record<string, number>) => string
  TOOLTIPS: Record<string, string>
}>(
  ['format.js', 'metrics.js'],
  '{ escapeHtml, formatNumber, formatMetric, formatDateTime, statusLabel, statusTooltip, renderMetricChips, runStatChips, renderLegacyOnlyNotice, renderBaselineOnlyNotice, renderCacheChip, renderPartialEvaluationChip, renderModelCell, renderProviderChip, renderDuplicateNotice, TOOLTIPS }'
)

const { escapeHtml, formatNumber, formatMetric, formatDateTime, statusLabel, statusTooltip, renderMetricChips, runStatChips, renderLegacyOnlyNotice, renderBaselineOnlyNotice, renderCacheChip, renderPartialEvaluationChip, renderModelCell, renderProviderChip, renderDuplicateNotice, TOOLTIPS } = api

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

  it('shows the position direction in Hungarian with a plain-language explanation', () => {
    const html = renderMetricChips({
      elicitationMode: 'single_choice',
      positionShift: -0.5,
      positionShiftSampleSize: 8
    })
    expect(html).toMatch(/elsőbbségi hatás|primacy/i)
    expect(html).toContain('-0.50')
    expect(html).toMatch(/elsőként mutatott opciót preferálja/i)
    expect(html).toMatch(/jó minőségűnek látja/i)
  })

  it('renders an explicit “nem elég adat” chip instead of formatting a missing shift as zero', () => {
    const html = renderMetricChips({
      elicitationMode: 'single_choice',
      positionShift: null,
      positionShiftSampleSize: 7
    })
    expect(html).toMatch(/nem elég adat/i)
    expect(html).toContain('7')
    expect(html).not.toMatch(/(?:eltolódás|primacy|recency)[^<]*0[,.]00/i)
  })

  it('does not show a position-shift chip for multi-choice questions', () => {
    const html = renderMetricChips({
      elicitationMode: 'multi_choice',
      positionShift: null,
      positionShiftSampleSize: 0
    })
    expect(html).not.toMatch(/pozíció-eltolódás|primacy|recency|nem elég adat/i)
  })
})

describe('renderMetricChips — elicitation mode', () => {
  it('marks a multi-choice question so its numbers are not read as a distribution', () => {
    const html = renderMetricChips({ elicitationMode: 'multi_choice' } as QuestionLike)
    expect(html).toContain('Többválaszos')
    expect(html).toContain(escapeHtml(TOOLTIPS.multiChoice))
  })

  it('says nothing extra for an ordinary single-choice question', () => {
    expect(renderMetricChips({ elicitationMode: 'single_choice' } as QuestionLike)).not.toContain('Többválaszos')
  })

  it('warns loudly when responses were dropped because of the old elicitation', () => {
    const html = renderMetricChips({ elicitationMode: 'multi_choice', legacyElicitationCount: 12 } as QuestionLike)
    expect(html).toContain('12 válasz kihagyva')
    expect(html).toContain(escapeHtml(TOOLTIPS.legacyElicitation))
  })
})

/**
 * Issue #40 review HIGH: `legacyElicitationBaselineCount` (src/lib/results.ts,
 * issue #40 review MEDIUM — dropped control-arm rows whose elicitation_mode
 * does not match the question) has NO rendering counterpart anywhere in the
 * UI. `renderMetricChips` binds only the persona-side `legacyElicitationCount`
 * into a chip (metrics.js:131-136); a researcher has no way to learn that
 * control-arm rows were dropped for data-quality reasons. This mirrors the
 * existing persona-side chip test above, one section up.
 */
describe('renderMetricChips — control-arm legacy elicitation chip (issue #40 review HIGH)', () => {
  it('warns about dropped control-arm rows, distinguishably from the persona-side chip', () => {
    const html = renderMetricChips({
      elicitationMode: 'single_choice',
      legacyElicitationBaselineCount: 5
    } as QuestionLike)
    expect(html).toContain('5')
    expect(html).toMatch(/kihagyva/i)
    // Must name the control arm explicitly — an unqualified "5 válasz
    // kihagyva" chip would be indistinguishable from the persona-side one.
    expect(html).toMatch(/kontroll/i)
  })

  it('shows the persona-side and control-arm-side legacy warnings together, both counts intact, when both sides dropped rows', () => {
    const html = renderMetricChips({
      elicitationMode: 'single_choice',
      legacyElicitationCount: 3,
      legacyElicitationBaselineCount: 2
    } as QuestionLike)
    expect(html).toContain('3')
    expect(html).toContain('2')
    expect(html).toMatch(/kontroll/i)
  })

  it('stays silent about the control arm when nothing was dropped on that side', () => {
    const html = renderMetricChips({
      elicitationMode: 'single_choice',
      legacyElicitationCount: 0,
      legacyElicitationBaselineCount: 0
    } as QuestionLike)
    expect(html).not.toMatch(/kontroll.*kihagyva|kihagyva.*kontroll/i)
  })

  it('never emits an unescaped tooltip quote', () => {
    expect(
      renderMetricChips({ elicitationMode: 'single_choice', legacyElicitationBaselineCount: 5 } as QuestionLike)
    ).not.toMatch(/title="[^"]*"[^ =>]/)
  })
})

/**
 * Issue #40 review MEDIUM: the baseline (control-arm) PC tooltip dropped the
 * metric's own DEFINITION ("hányszor azonos a topválasz" — how many times
 * the top answer is identical) in favour of wording that reads as "measures
 * WHAT the top answer is", not "measures HOW STABLE it is". The RS-baseline
 * sibling tooltip correctly kept the "hányszor azonos" structure — the PC
 * one is the odd one out.
 */
describe('TOOLTIPS.positionConsistencyBaseline (issue #40 review MEDIUM)', () => {
  it('keeps the metric’s own definition — "hányszor azonos" — like its RS-baseline sibling does, not just what it measures the absence of', () => {
    expect(TOOLTIPS.positionConsistencyBaseline).toMatch(/hányszor azonos/)
  })
})

/**
 * Issue #40 review, HIGH/B: before #40, a baseline-only question's PC/RS chip
 * simply did not appear (both were `null`). Since #40 computes real PC/RS for
 * the control arm, the SAME plain "PC 0.85" chip now appears — with the SAME
 * generic tooltip — for a persona-bearing question and a persona-free
 * (calibration) one. The only place that currently says "this question has no
 * persona data, only the control arm" is the collapsed "Perszóna szintű
 * bontás" <details> (renderBaselineOnlyNotice), which a reader does not open by
 * default. The target user is a media professional, not a developer — an
 * unexplained or misleading metric on the visible surface is a defect (project
 * rule, issue #28 lineage).
 *
 * Design decision (see task report): a question counts as baseline-only using
 * the SAME condition `renderBaselineOnlyNotice` (this file, below) already
 * uses — `Object.keys(question.byPersona || {}).length === 0 &&
 * !!question.baseline` — for consistency with that established convention,
 * rather than `aggregatedResponseCount === 0` (which can also be 0 in a mixed
 * run where the persona rows exist but were all invalid/abstained — a
 * genuinely different situation from "no persona was ever asked").
 */
describe('renderMetricChips — control-arm PC/RS chip is distinguishable on a baseline-only question (issue #40 review HIGH/B)', () => {
  it('marks the PC/RS chip as measuring the control arm when the question has no persona data at all', () => {
    const html = renderMetricChips({
      positionConsistency: 0.85,
      repetitionStability: 0.9,
      byPersona: {},
      baseline: [0.9, 0.1]
    } as QuestionLike)
    expect(html).toContain('PC 0.85')
    // Label and/or tooltip must say this is the control arm's own number — a
    // bare "kontroll" match on the rendered markup (label text OR title
    // attribute) is enough; this test does not prescribe which.
    expect(html).toMatch(/kontroll/i)
  })

  it('leaves today’s plain PC/RS chip wording for a persona-bearing question — no regression', () => {
    const html = renderMetricChips({
      positionConsistency: 0.85,
      repetitionStability: 0.9,
      byPersona: { p1: { name: 'P1' } },
      baseline: [0.9, 0.1]
    } as QuestionLike)
    expect(html).toContain('PC 0.85')
    expect(html).not.toMatch(/kontroll/i)
  })

  it('leaves the plain chip wording when there is no control arm at all (ordinary persona-only run) — no regression', () => {
    const html = renderMetricChips({
      positionConsistency: 0.85,
      repetitionStability: 0.9,
      byPersona: {},
      baseline: null
    } as QuestionLike)
    expect(html).toContain('PC 0.85')
    expect(html).not.toMatch(/kontroll/i)
  })
})

describe('renderLegacyOnlyNotice', () => {
  it('replaces an empty aggregate with an explanation when only legacy responses exist', () => {
    const html = renderLegacyOnlyNotice({ legacyElicitationCount: 336, aggregatedResponseCount: 0 })
    expect(html).toContain('336')
    expect(html).toContain('újra kell futtatni')
  })

  it('stays out of the way when there is something to aggregate', () => {
    expect(renderLegacyOnlyNotice({ legacyElicitationCount: 336, aggregatedResponseCount: 12 })).toBe('')
    expect(renderLegacyOnlyNotice({ legacyElicitationCount: 0, aggregatedResponseCount: 0 })).toBe('')
  })
})

// Issue #32: a calibration (control-arm-only) question has an empty byPersona
// but a populated baseline — that must read as a named control-arm group, not
// as "no data".
describe('renderBaselineOnlyNotice', () => {
  it('names the control arm when a question has no persona data but does have a baseline', () => {
    const html = renderBaselineOnlyNotice({ byPersona: {}, baseline: [0.8, 0.2] })
    expect(html).toContain('Kontroll — perszóna nélkül')
  })

  it('stays out of the way when persona data exists', () => {
    expect(renderBaselineOnlyNotice({ byPersona: { p1: {} }, baseline: [0.8, 0.2] })).toBe('')
  })

  it('stays out of the way when there is no baseline either (truly nothing to show)', () => {
    expect(renderBaselineOnlyNotice({ byPersona: {}, baseline: null })).toBe('')
  })
})

describe('renderCacheChip', () => {
  it('returns empty string when cachedTokens is falsy', () => {
    expect(renderCacheChip({ cachedTokens: 0, promptTokens: 100 })).toBe('')
    expect(renderCacheChip({ cachedTokens: undefined, promptTokens: 100 })).toBe('')
    expect(renderCacheChip({ cachedTokens: null as unknown as number, promptTokens: 100 })).toBe('')
  })

  it('returns empty string when promptTokens is falsy', () => {
    expect(renderCacheChip({ cachedTokens: 50, promptTokens: 0 })).toBe('')
    expect(renderCacheChip({ cachedTokens: 50, promptTokens: undefined })).toBe('')
    expect(renderCacheChip({ cachedTokens: 50, promptTokens: null as unknown as number })).toBe('')
  })

  it('renders a cache chip with percentage and token count', () => {
    const html = renderCacheChip({ cachedTokens: 4000, promptTokens: 10000 })
    expect(html).toContain('⚡')
    expect(html).toContain('cache')
    expect(html).toContain('40%')
    // formatNumber may vary locale-dependent; check for the core digits
    expect(html).toMatch(/40%.*4.*0+.*token/)
  })

  it('rounds the percentage to a whole number', () => {
    const html = renderCacheChip({ cachedTokens: 333, promptTokens: 1000 })
    expect(html).toContain('33%')
  })

  it('includes a tooltip explaining cache pricing benefit', () => {
    const html = renderCacheChip({ cachedTokens: 4000, promptTokens: 10000 })
    expect(html).toContain(escapeHtml(TOOLTIPS.cache))
    expect(html).not.toMatch(/title="[^"]*"[^ =>]/)
  })
})

describe('renderPartialEvaluationChip', () => {
  it('returns empty string when run_status is missing', () => {
    expect(renderPartialEvaluationChip({})).toBe('')
  })

  it('returns empty string when run_status is "completed"', () => {
    expect(renderPartialEvaluationChip({ run_status: 'completed', done_cells: 50, total_cells: 50 })).toBe('')
  })

  it('renders a warning chip for incomplete runs with valid cell counts', () => {
    const html = renderPartialEvaluationChip({ run_status: 'running', done_cells: 78, total_cells: 232 })
    expect(html).toContain('⚠')
    expect(html).toContain('Részeredmény')
    expect(html).toContain('metric-chip-warning')
    expect(html).toContain('78')
    expect(html).toContain('232')
    // Check for reworded tooltip mentioning responses
    expect(html).toContain('válasz volt rögzítve')
  })

  it('falls back to generic tooltip when done_cells is null', () => {
    const html = renderPartialEvaluationChip({ run_status: 'running', done_cells: null, total_cells: 232 })
    expect(html).toContain('⚠')
    expect(html).toContain('Részeredmény')
    expect(html).toContain(escapeHtml(TOOLTIPS.partialEvaluation))
    expect(html).not.toContain('cellából')
  })

  it('falls back to generic tooltip when total_cells is null', () => {
    const html = renderPartialEvaluationChip({ run_status: 'running', done_cells: 78, total_cells: null })
    expect(html).toContain('⚠')
    expect(html).toContain(escapeHtml(TOOLTIPS.partialEvaluation))
    expect(html).not.toContain('válasz volt rögzítve')
  })

  it('falls back to generic tooltip when total_cells is zero', () => {
    const html = renderPartialEvaluationChip({ run_status: 'running', done_cells: 0, total_cells: 0 })
    expect(html).toContain(escapeHtml(TOOLTIPS.partialEvaluation))
    expect(html).not.toContain('cellából')
  })

  it('falls back to generic tooltip when done_cells > total_cells', () => {
    const html = renderPartialEvaluationChip({ run_status: 'running', done_cells: 300, total_cells: 232 })
    expect(html).toContain(escapeHtml(TOOLTIPS.partialEvaluation))
    expect(html).not.toContain('300 válasz')
  })

  it('falls back to generic tooltip when counts are undefined', () => {
    const html = renderPartialEvaluationChip({ run_status: 'paused' })
    expect(html).toContain('⚠')
    expect(html).toContain('Részeredmény')
    expect(html).toContain(escapeHtml(TOOLTIPS.partialEvaluation))
    expect(html).not.toContain('cellából')
  })

  it('never emits an unescaped tooltip quote', () => {
    expect(renderPartialEvaluationChip({ run_status: 'running', done_cells: 78, total_cells: 232 })).not.toMatch(
      /title="[^"]*"[^ =>]/
    )
  })
})

describe('runStatChips — cache', () => {
  it('shows the cache chip inside the run summary when there were cache hits', () => {
    const html = runStatChips({
      done: 4, totalCells: 8, invalid: 0, abstained: 0, totalTokens: 1000, costUsd: 0,
      cachedTokens: 400, promptTokens: 800
    })
    expect(html).toContain('cache: 50%')
  })

  it('omits it when the provider reported no cache hits', () => {
    const html = runStatChips({ done: 4, totalCells: 8, invalid: 0, abstained: 0, totalTokens: 1000, costUsd: 0, cachedTokens: 0, promptTokens: 800 })
    expect(html).not.toContain('cache')
  })
})

describe('renderModelCell', () => {
  it('renders model version alone when provider is missing', () => {
    const html = renderModelCell({ model_version: 'claude-3-opus-20250219' })
    expect(html).toContain('claude-3-opus-20250219')
    expect(html).not.toContain('provider-tag')
    expect(html).toContain('A szolgáltató nincs rögzítve')
  })

  it('renders model version with provider tag when provider is present', () => {
    const html = renderModelCell({ model_version: 'claude-3-opus-20250219', provider: 'Anthropic' })
    expect(html).toContain('claude-3-opus-20250219')
    expect(html).toContain('provider-tag')
    expect(html).toContain('Anthropic')
    expect(html).toContain('Kiszolgáló szolgáltató')
  })

  it('escapes special characters in model_version to prevent injection', () => {
    const html = renderModelCell({ model_version: '<img src=x onerror=alert(1)>' })
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
    expect(html).not.toMatch(/<img/)
  })

  it('escapes special characters in provider to prevent injection', () => {
    const html = renderModelCell({ model_version: 'claude', provider: '"><script>alert(1)</script><span class="' })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&quot;')
    expect(html).toContain('&lt;')
  })

  it('handles null/undefined response gracefully', () => {
    expect(renderModelCell(null as unknown as ResponseLike)).toBe('—')
  })

  it('never emits unescaped tooltip quotes', () => {
    const html = renderModelCell({ model_version: 'v1', provider: 'TestProvider' })
    expect(html).not.toMatch(/title="[^"]*"[^ =>]/)
  })
})

describe('renderProviderChip', () => {
  it('says nothing when no provider was recorded', () => {
    expect(renderProviderChip([])).toBe('')
    expect(renderProviderChip(undefined as unknown as [])).toBe('')
  })

  it('names the single provider that served the whole run', () => {
    const html = renderProviderChip([{ provider: 'DeepInfra', count: 12 }])
    expect(html).toContain('DeepInfra')
    expect(html).not.toContain('⚠')
  })

  it('warns when several providers served one run, and lists the split', () => {
    const html = renderProviderChip([
      { provider: 'DeepInfra', count: 7 },
      { provider: 'Venice', count: 5 }
    ])
    expect(html).toContain('2 szolgáltató')
    expect(html).toContain('stat-chip-danger')
    expect(html).toContain(escapeHtml('DeepInfra (7), Venice (5)'))
    expect(html).not.toMatch(/title="[^"]*"[^ =>]/)
  })
})

describe('renderDuplicateNotice', () => {
  it('stays silent for clean data', () => {
    expect(renderDuplicateNotice({ duplicateResponseCount: 0 })).toBe('')
    expect(renderDuplicateNotice(undefined as unknown as Record<string, number>)).toBe('')
  })

  it('names the repeated cells and explains what was done with them', () => {
    const html = renderDuplicateNotice({ duplicateResponseCount: 336 })
    expect(html).toContain('336')
    expect(html).toContain(escapeHtml(TOOLTIPS.duplicateCells))
  })
})
