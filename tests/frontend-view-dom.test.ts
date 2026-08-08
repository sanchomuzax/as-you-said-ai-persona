import { describe, it, expect, afterEach } from 'vitest'
import { loadAppDom, defaultRoutes, type AppDom } from './helpers/load-app-dom.js'

/**
 * View-controller tests for entity-view.js and run-view.js (issue #10). These
 * were previously covered only by manual browser checks — which is where the
 * misleading-number class of bug lives.
 */

let dom: AppDom | null = null

afterEach(() => {
  dom?.close()
  dom = null
})

const PROJECT = { id: 'p1', name: 'Startlap', applicationDomain: 'Hírportál', targetPopulation: '18-65' }
const PERSONA = {
  id: 'per1',
  projectId: 'p1',
  lineageId: 'per1',
  name: 'Anna',
  version: 1,
  isLatest: true,
  demographics: { kor: 34, település: 'Budapest' },
  biography: 'Két gyerek mellett dolgozik.',
  renderingStyle: 'bulleted_profile',
  provenance: { forrás: 'KSH Mikrocenzus 2022' },
  createdAt: '2026-08-06 10:00:00'
}
const QUESTIONNAIRE = {
  id: 'qn1',
  projectId: 'p1',
  name: 'Akciós tájékozódás',
  version: 1,
  isLatest: true,
  createdAt: '2026-08-06 10:00:00',
  questions: [
    { id: 'q1', text: 'Hogyan tájékozódsz?', options: ['Újság', 'App'], scaleType: 'single_choice', scaleDirection: 'ascending' }
  ]
}
const RUN = {
  id: 'r1',
  name: 'Első futás',
  status: 'completed',
  questionnaire_id: 'qn1',
  config_json: JSON.stringify({ model: 'm1', temperature: 1, seeds: [0] }),
  response_count: 2,
  invalid_count: 0,
  created_at: '2026-08-06 10:00:00'
}

function entityRoutes(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return defaultRoutes({
    'GET /api/projects': [PROJECT],
    'GET /api/personas': [PERSONA],
    'GET /api/personas/per1': PERSONA,
    'GET /api/personas/per1/versions': [PERSONA],
    'GET /api/questionnaires': [QUESTIONNAIRE],
    'GET /api/questionnaires/qn1': QUESTIONNAIRE,
    'GET /api/questionnaires/qn1/versions': [QUESTIONNAIRE],
    'GET /api/projects/p1': PROJECT,
    'GET /api/runs': [RUN],
    ...overrides
  })
}

async function selectProject(d: AppDom, id = 'p1'): Promise<void> {
  const select = d.document.getElementById('personaProjectSelect')!
  select.value = id
  select.dispatchEvent(new d.window.Event('change', { bubbles: true }))
  await d.settle()
}

describe('entity detail view', () => {
  it('opens a persona and shows demographics and the provenance source', async () => {
    dom = loadAppDom({ routes: entityRoutes() })
    await dom.boot()
    await selectProject(dom)
    ;(dom.document.querySelector('[data-entity="personas"]')!).click()
    await dom.settle()

    const body = dom.document.getElementById('entityDetailBody')!.textContent!
    expect(dom.document.getElementById('entityDetailView')!.style.display).toBe('block')
    expect(dom.document.getElementById('entityDetailTitle')!.textContent).toContain('Anna')
    expect(body).toContain('34')
    expect(body).toContain('KSH Mikrocenzus 2022')
  })

  it('opens a questionnaire and lists its questions with the answer options', async () => {
    dom = loadAppDom({ routes: entityRoutes() })
    await dom.boot()
    const select = dom.document.getElementById('questionnaireProjectSelect')!
    select.value = 'p1'
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    await dom.settle()
    ;(dom.document.querySelector('[data-entity="questionnaires"]')!).click()
    await dom.settle()

    const body = dom.document.getElementById('entityDetailBody')!.textContent!
    expect(body).toContain('Hogyan tájékozódsz?')
    expect(body).toContain('Újság')
  })

  it('opens a project and shows its personas, questionnaires and runs', async () => {
    dom = loadAppDom({ routes: entityRoutes() })
    await dom.boot()
    ;(dom.document.querySelector('[data-entity="projects"]')!).click()
    await dom.settle()
    const body = dom.document.getElementById('entityDetailBody')!.textContent!
    expect(body).toContain('Anna')
    expect(body).toContain('Akciós tájékozódás')
    // The run list is now filtered server-side; nothing else in the suite would
    // notice if the section stopped rendering what the server returned.
    expect(body).toContain('Első futás')
    expect(dom.document.querySelector('[data-run="r1"]')).not.toBeNull()
  })

  it('says an entity is gone rather than reporting a load failure', async () => {
    dom = loadAppDom({ routes: entityRoutes() })
    dom.window.location.hash = '#personas/deleted'
    await dom.boot()
    const body = dom.document.getElementById('entityDetailBody')!.textContent!
    expect(body).toMatch(/már nem létezik|nem található/i)
    expect(body).not.toMatch(/sikertelen/i)
  })

  // Issue #11: the detail views used to download whole collections to show one
  // item. What is observable from the outside is which URLs they request.
  it('fetches one project and only that project runs, not every run', async () => {
    dom = loadAppDom({ routes: entityRoutes() })
    await dom.boot()
    const before = dom.calls.length
    dom.document.querySelector('[data-entity="projects"]')!.click()
    await dom.settle()
    const urls = dom.calls.slice(before).map((c) => c.url)
    expect(urls).toContain('/api/projects/p1')
    expect(urls).toContain('/api/runs?project=p1')
    expect(urls).not.toContain('/api/runs')
    expect(urls).not.toContain('/api/projects')
  })

  it('restores an entity detail from the URL hash', async () => {
    dom = loadAppDom({ routes: entityRoutes() })
    dom.window.location.hash = '#personas/per1'
    await dom.boot()
    expect(dom.document.getElementById('entityDetailView')!.style.display).toBe('block')
    expect(dom.document.getElementById('entityDetailTitle')!.textContent).toContain('Anna')
  })

  it('closes on Vissza and returns to the tab list', async () => {
    dom = loadAppDom({ routes: entityRoutes() })
    await dom.boot()
    ;(dom.document.querySelector('[data-entity="projects"]')!).click()
    await dom.settle()
    ;(dom.document.getElementById('entityDetailBackBtn')!).click()
    await dom.settle()
    expect(dom.document.getElementById('entityDetailView')!.style.display).toBe('none')
  })
})

describe('run detail view', () => {
  const RESPONSES = [
    {
      id: 'resp1',
      persona_id: 'per1',
      persona_name: 'Anna',
      question_id: 'q1',
      question_text: 'Hogyan tájékozódsz?',
      options_json: JSON.stringify(['Újság', 'App']),
      elicitation_mode: 'single_choice',
      condition: 'persona',
      model_version: 'm1-2026-05',
      provider: 'DeepInfra',
      seed: 0,
      permutation_json: '[0,1]',
      parsed_distribution_json: JSON.stringify({ '0': 0.7, '1': 0.3 }),
      parsed_answer: '0',
      is_valid: 1,
      abstained: 0,
      prompt_tokens: 40,
      completion_tokens: 12,
      cost_usd: 0.001,
      latency_ms: 100,
      created_at: '2026-08-06 10:00:00'
    },
    {
      id: 'resp2',
      persona_id: null,
      persona_name: null,
      question_id: 'q1',
      question_text: 'Hogyan tájékozódsz?',
      options_json: JSON.stringify(['Újság', 'App']),
      elicitation_mode: 'single_choice',
      condition: 'baseline',
      model_version: 'm1-2026-05',
      provider: 'DeepInfra',
      seed: 0,
      permutation_json: '[0,1]',
      parsed_distribution_json: null,
      parsed_answer: null,
      is_valid: 1,
      // an abstention is a valid response: it must not display as a plain tick
      abstained: 1,
      prompt_tokens: 30,
      completion_tokens: 5,
      cost_usd: 0.0005,
      latency_ms: 90,
      created_at: '2026-08-06 10:00:01'
    }
  ]

  const PROGRESS = {
    status: 'completed',
    providers: [{ provider: 'DeepInfra', count: 2 }],
    staleVersions: { questionnaire: null, personas: [] },
    totalCells: 2,
    done: 2,
    invalid: 0,
    abstained: 1,
    avgLatencyMs: 95,
    usage: { promptTokens: 70, completionTokens: 17, totalTokens: 87, cachedTokens: 0, costUsd: 0.0015 }
  }

  function runRoutes(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return entityRoutes({
      'GET /api/runs/r1': {
        run: RUN,
        responses: RESPONSES,
        usage: PROGRESS.usage,
        staleVersions: { questionnaire: null, personas: [] }
      },
      'GET /api/runs/r1/progress': PROGRESS,
      'GET /api/runs/r1/results': {
        totalResponses: 2,
        cellIndexPresent: true,
        invalidCount: 0,
        abstainedCount: 1,
        duplicateResponseCount: 0,
        questions: [],
        personas: []
      },
      'GET /api/runs/r1/evaluations': [],
      ...overrides
    })
  }

  it('opens a run from the card and shows its status and progress', async () => {
    dom = loadAppDom({ routes: runRoutes() })
    await dom.boot()
    ;(dom.document.querySelector('[data-run-card="r1"]')!).click()
    await dom.settle()

    expect(dom.document.getElementById('runDetailView')!.style.display).toBe('block')
    expect(dom.document.getElementById('runDetailTitle')!.textContent).toContain('Első futás')
    expect(dom.document.getElementById('runDetailStats')!.textContent).toContain('2')
  })

  // public/run-view.js's refreshRunDetailHeader falls back to
  // `state.runProgress[runId] || {}` when /progress fails — empty for a
  // non-running run, since boot no longer pre-populates it (issue #22). A run
  // that really cost 1.9M tokens must not render as "0/0 cella · 0 token ·
  // 0.0000 USD": that is a wrong number, not a stale one, and its own list
  // card (issue #22's usage fields) shows the truth one click away. Either
  // the header shows those same real numbers, or it says the figure is
  // unknown — either is acceptable, silently fabricating zero is not.
  it('does not fabricate a zero header when /progress fails for a run with real spend', async () => {
    const richRun = {
      ...RUN,
      total_cells: 50,
      done_cells: 50,
      invalid_count: 0,
      abstained_count: 0,
      stale_versions: 0,
      prompt_tokens: 1_500_000,
      completion_tokens: 400_000,
      cached_tokens: 0,
      total_tokens: 1_900_000,
      cost_usd: 12.34
    }
    dom = loadAppDom({
      routes: runRoutes({
        'GET /api/runs': [richRun],
        'GET /api/runs/r1/progress': undefined
      })
    })
    await dom.boot()
    ;(dom.document.querySelector('[data-run-card="r1"]')!).click()
    await dom.settle()

    // Compared chip-by-chip, not as one concatenated string: the real total
    // (1 900 000, grouped by hu-HU's locale formatting) legitimately CONTAINS
    // the substring "0 token" near its own end, which would make a naive
    // "not.toContain" pass for the wrong reason.
    const chipTexts = Array.from(dom.document.querySelectorAll('#runDetailStats .stat-chip')).map((chip) =>
      chip.textContent!.trim()
    )
    expect(chipTexts).not.toContain('0/0 cella')
    expect(chipTexts).not.toContain('0 token')
    expect(chipTexts).not.toContain('0.0000 USD')
  })

  it('fills the responses table, marking the abstention as an evidence gap', async () => {
    dom = loadAppDom({ routes: runRoutes() })
    await dom.boot()
    ;(dom.document.querySelector('[data-run-card="r1"]')!).click()
    await dom.settle()
    ;(dom.document.querySelector('[data-subtab="responses"]')!).click()
    await dom.settle()

    const rows = dom.document.querySelectorAll('#responsesTableBody tr')
    expect(rows.length).toBe(2)
    const table = dom.document.getElementById('responsesTableBody')!.textContent!
    expect(table).toContain('Anna')
    // the abstention must not be rendered as an ordinary valid tick
    expect(table).toMatch(/—|tartózk/i)
  })

  it('switches to the evaluation subtab and reports that there is none yet', async () => {
    dom = loadAppDom({ routes: runRoutes() })
    await dom.boot()
    ;(dom.document.querySelector('[data-run-card="r1"]')!).click()
    await dom.settle()
    ;(dom.document.querySelector('[data-subtab="evaluation"]')!).click()
    await dom.settle()
    expect(dom.document.getElementById('subtab-evaluation')!.className).toContain('active')
    expect(dom.document.getElementById('evaluationsList')!.textContent).toMatch(/nincs|Nincs/)
  })

  // Issue #17 M3: the evaluation record now carries which calibration profile
  // (docs/MODEL-CALIBRATION.md §4) was in context — an evaluation view that
  // stays silent about it would let a researcher read persona numbers as
  // absolute when the judge actually reasoned against a (possibly stale, or
  // entirely absent) baseline.
  describe('evaluation calibration-profile reference (issue #17 M3)', () => {
    async function openEvaluationTab(evaluations: unknown[]): Promise<void> {
      dom = loadAppDom({ routes: runRoutes({ 'GET /api/runs/r1/evaluations': evaluations }) })
      await dom.boot()
      ;(dom.document.querySelector('[data-run-card="r1"]')!).click()
      await dom.settle()
      ;(dom.document.querySelector('[data-subtab="evaluation"]')!).click()
      await dom.settle()
    }

    it('names the valid profile an evaluation used', async () => {
      await openEvaluationTab([
        {
          id: 'ev1', model: 'm1-2026-05', content: 'Szöveg', prompt_tokens: 10, completion_tokens: 5,
          cost_usd: 0.001, created_at: '2026-08-06 10:00:00', model_profile_id: 'prof-1', model_profile_status: 'valid'
        }
      ])
      const text = dom!.document.getElementById('evaluationsList')!.textContent!
      expect(text).toMatch(/kalibráci/i)
      // Same status wording model-card.js's calibrationStatusChip already uses
      // for 'valid' — one vocabulary for calibration status across the app.
      expect(text).toMatch(/érvényes/i)
    })

    it('names the profile as stale when it was already outdated at evaluation time', async () => {
      await openEvaluationTab([
        {
          id: 'ev1', model: 'm1-2026-05', content: 'Szöveg', prompt_tokens: 10, completion_tokens: 5,
          cost_usd: 0.001, created_at: '2026-08-06 10:00:00', model_profile_id: 'prof-1', model_profile_status: 'stale'
        }
      ])
      const text = dom!.document.getElementById('evaluationsList')!.textContent!
      expect(text).toMatch(/elavult/i)
    })

    it('states plainly that no calibration profile was available, rather than staying silent', async () => {
      await openEvaluationTab([
        {
          id: 'ev1', model: 'm1-2026-05', content: 'Szöveg', prompt_tokens: 10, completion_tokens: 5,
          cost_usd: 0.001, created_at: '2026-08-06 10:00:00', model_profile_id: null, model_profile_status: null
        }
      ])
      const text = dom!.document.getElementById('evaluationsList')!.textContent!
      expect(text).toMatch(/nincs.*kalibráci|nem volt kalibrációs profil/i)
    })

    // M3 review MEDIUM #6: a bare status chip alone does not identify WHICH
    // profile was used — two different profiles for the same model (different
    // measurement date, cell count, provider) would render identically. §6 of
    // the spec requires every evaluation to cite its profile. The id is
    // already in the API payload; the card must also name the measured stack
    // and date so two profiles are visibly distinguishable.
    it('names the profile’s model version, provider and measurement date, not just its status', async () => {
      await openEvaluationTab([
        {
          id: 'ev1', model: 'm1-2026-05', content: 'Szöveg', prompt_tokens: 10, completion_tokens: 5,
          cost_usd: 0.001, created_at: '2026-08-06 10:00:00', model_profile_id: 'prof-1',
          model_profile_status: 'valid', model_profile_model_version: 'm1-2026-05',
          model_profile_provider: 'DeepInfra', model_profile_measured_at: '2026-07-01 09:00:00'
        }
      ])
      const text = dom!.document.getElementById('evaluationsList')!.textContent!
      expect(text).toContain('DeepInfra')
      // Any date rendering (hu-HU locale, ISO, etc.) will keep the year and
      // month digits — a stable fragment that survives formatting choices.
      expect(text).toMatch(/2026[.\-/]\s*0?7/)
    })
  })

  it('points the CSV export at the open run', async () => {
    dom = loadAppDom({ routes: runRoutes() })
    await dom.boot()
    ;(dom.document.querySelector('[data-run-card="r1"]')!).click()
    await dom.settle()
    expect(dom.document.getElementById('runExportLink')!.getAttribute('href')).toContain('/api/runs/r1/export.csv')
  })

  it('restores an open run from the URL hash', async () => {
    dom = loadAppDom({ routes: runRoutes() })
    dom.window.location.hash = '#runs/r1'
    await dom.boot()
    expect(dom.document.getElementById('runDetailView')!.style.display).toBe('block')
    expect(dom.document.getElementById('runDetailTitle')!.textContent).toContain('Első futás')
  })

  /**
   * Issue #40 review, HIGH/B, exercised through the REAL overview tab renderer
   * (public/run-view.js's loadOverviewTab -> metrics.js's renderMetricChips),
   * not just the isolated helper function — this is the actual visible surface
   * a researcher reads. Since #40, a baseline-only (calibration) question's PC/RS
   * chip looks IDENTICAL to a persona-bearing question's — the only place that
   * currently says "this is the control arm, not a persona" is the collapsed
   * "Perszóna szintű bontás" <details>, which is not open by default.
   */
  describe('overview tab — control-arm PC/RS chip is distinguishable on a baseline-only question (issue #40 review HIGH/B)', () => {
    function resultsWithBaselineOnlyQuestion(): unknown {
      return {
        totalResponses: 2,
        invalidRate: 0,
        abstainRate: 0,
        duplicateResponseCount: 0,
        questions: [
          {
            questionId: 'q1',
            text: 'Hogyan tájékozódsz?',
            options: ['Újság', 'App'],
            scaleType: 'single_choice',
            elicitationMode: 'single_choice',
            legacyElicitationCount: 0,
            aggregatedResponseCount: 0,
            totalResponses: 2,
            invalidCount: 0,
            abstainCount: 0,
            aggregated: [0, 0],
            byPersona: {},
            baseline: [0.9, 0.1],
            positionConsistency: 0.85,
            repetitionStability: 0.9
          }
        ]
      }
    }

    it('marks the chip as the control arm’s on the visible overview tab of a calibration (baseline-only) question', async () => {
      dom = loadAppDom({
        routes: runRoutes({ 'GET /api/runs/r1/results': resultsWithBaselineOnlyQuestion() })
      })
      await dom.boot()
      ;(dom.document.querySelector('[data-run-card="r1"]')!).click()
      await dom.settle()

      const chips = dom.document.querySelector('.question-card .metric-chips')!
      expect(chips.textContent).toContain('PC 0.85')
      // Checked via the full markup (innerHTML), not just visible text: the
      // distinguishing wording is allowed to live in the tooltip/aria-label
      // (an attribute, not a text node) as well as in the visible label.
      expect(chips.innerHTML).toMatch(/kontroll/i)
      // This must be visible WITHOUT opening the collapsed persona-breakdown
      // <details> — the researcher's default view.
      const details = dom.document.querySelector('.persona-breakdown-wrap')
      expect(details?.getAttribute('open')).toBeFalsy()
    })

    it('leaves the plain PC/RS chip wording for a persona-bearing question on the same overview tab — no regression', async () => {
      const results = resultsWithBaselineOnlyQuestion() as { questions: Record<string, unknown>[] }
      results.questions[0]!.byPersona = { per1: { name: 'Anna', distribution: [0.9, 0.1], abstainCount: 0, baselineDivergence: 0, movesModel: false } }
      dom = loadAppDom({ routes: runRoutes({ 'GET /api/runs/r1/results': results }) })
      await dom.boot()
      ;(dom.document.querySelector('[data-run-card="r1"]')!).click()
      await dom.settle()

      const chips = dom.document.querySelector('.question-card .metric-chips')!
      expect(chips.textContent).toContain('PC 0.85')
      expect(chips.innerHTML).not.toMatch(/kontroll/i)
    })
  })

  /**
   * Issue #40 review CRITICAL: `run-view.js`'s `renderPersonaBreakdown` only
   * special-cases `movesModel === false` (' (zajszint)' suffix,
   * public/run-view.js:236). Since the CRITICAL fix makes `movesModel` also
   * come back `null` while `baselineDivergence` is a REAL, non-null number
   * (control arm exists, but its own noise floor could not be measured — see
   * the contract in tests/results.test.ts), today's code renders that case
   * with NO suffix at all — identical to a plain, fully-decided divergence
   * number. A reader cannot tell "this persona genuinely moved the model"
   * apart from "we don't actually know". Required contract (mirrors
   * tests/results.test.ts): the cell must contain the phrase "nem eldönthető"
   * for this case, and must NOT contain "zajszint" (that word is reserved for
   * the genuinely-decided, `movesModel === false` case).
   */
  describe('persona breakdown — an undecidable movesModel is distinguishable from "within noise" (issue #40 review CRITICAL)', () => {
    function resultsWithMovesModelCases(): unknown {
      return {
        totalResponses: 4,
        invalidRate: 0,
        abstainRate: 0,
        duplicateResponseCount: 0,
        questions: [
          {
            questionId: 'q1',
            text: 'Hogyan tájékozódsz?',
            options: ['Újság', 'App'],
            scaleType: 'single_choice',
            elicitationMode: 'single_choice',
            legacyElicitationCount: 0,
            aggregatedResponseCount: 2,
            totalResponses: 4,
            invalidCount: 0,
            abstainCount: 0,
            aggregated: [0.69, 0.31],
            byPersona: {
              // Undecidable: a real divergence was computed, but the control
              // arm's own noise floor could not be measured.
              anna: { name: 'Anna', distribution: [0.78, 0.22], abstainCount: 0, baselineDivergence: 0.0157, movesModel: null },
              // Genuinely decided: within the measured noise floor — today's
              // existing behaviour, must not regress.
              bob: { name: 'Bob', distribution: [0.6, 0.4], abstainCount: 0, baselineDivergence: 0.1, movesModel: false }
            },
            baseline: [0.8, 0.2],
            positionConsistency: 0.9,
            repetitionStability: 0.9
          }
        ]
      }
    }

    it('marks Anna’s row (undecidable) differently from Bob’s (genuinely within noise), on the real overview tab', async () => {
      dom = loadAppDom({ routes: runRoutes({ 'GET /api/runs/r1/results': resultsWithMovesModelCases() }) })
      await dom.boot()
      ;(dom.document.querySelector('[data-run-card="r1"]')!).click()
      await dom.settle()

      const table = dom.document.querySelector('.persona-breakdown-table')!
      const html = table.innerHTML
      const annaIdx = html.indexOf('Anna')
      const bobIdx = html.indexOf('Bob')
      expect(annaIdx).toBeGreaterThanOrEqual(0)
      expect(bobIdx).toBeGreaterThan(annaIdx)
      const annaRowHtml = html.slice(annaIdx, bobIdx)
      const bobRowHtml = html.slice(bobIdx)

      // Scoped to the divergence CELL'S RENDERED TEXT only, not the whole
      // row's markup. That cell also carries a `title="…"` tooltip
      // (metrics.js's TOOLTIPS.personaEffect) which itself contains the
      // substring "zajszintet" — a whole-row `not.toMatch(/zajszint/i)`
      // would happen to pass today only because this implementation gave the
      // undecidable case ITS OWN separate tooltip wording that avoids the
      // word; a different, equally valid implementation that reused the same
      // tooltip and only changed the visible suffix would fail this check
      // for a reason that has nothing to do with the suffix itself (the same
      // whole-blob scope mistake as tests/results.test.ts's
      // evaluate.ts-facing test — see that file's comment for the general
      // pattern). Extracting the cell's own text content — the part after
      // the tag's closing `>`, before `</td>` — is robust to either choice.
      function divergenceCellText(rowHtml: string): string {
        const match = rowHtml.match(/title="[^"]*">([^<]*)<\/td>/)
        if (!match) throw new Error(`divergence cell not found in: ${rowHtml}`)
        return match[1]!
      }
      const annaCellText = divergenceCellText(annaRowHtml)
      const bobCellText = divergenceCellText(bobRowHtml)

      // Regression: Bob's genuinely-decided "within noise" case keeps its
      // existing, already-shipped wording — checked on the cell's own text,
      // not on a tooltip that would satisfy this trivially either way.
      expect(bobCellText).toMatch(/zajszint/i)

      // The divergence number itself must still be shown for Anna (never
      // hidden), together with the required "undecidable" qualifier — and it
      // must NOT borrow Bob's "within noise" wording, which would be a
      // different, false claim (her divergence was never actually compared
      // against a real noise floor).
      expect(annaCellText).toContain('0.02') // formatMetric(0.0157) === '0.02'
      expect(annaCellText).toContain('nem eldönthető')
      expect(annaCellText).not.toMatch(/zajszint/i)
    })
  })
})
