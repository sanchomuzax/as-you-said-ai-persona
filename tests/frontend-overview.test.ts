import { describe, it, expect, afterEach } from 'vitest'
import { loadAppDom, defaultRoutes, type AppDom } from './helpers/load-app-dom.js'

/**
 * Overview tab (issue #20): the new default landing tab, built entirely from
 * /api/runs, /api/model-profiles and /api/budget — no new server endpoint.
 * Shows what is running/stalled, what recently finished, and what needs
 * attention (uncalibrated models, stale-version runs, a near-exhausted budget).
 */

let dom: AppDom | null = null

afterEach(() => {
  dom?.close()
  dom = null
})

const VALID_MODEL_PROFILES = [
  { model: 'm1', label: 'Modell 1', status: 'valid', reasons: [], summary: null, profile: null }
]

// The server only ever emits byScope: { run, interview } (src/lib/budget.ts's
// usageByScope()) — there is no "measurement" scope key.
const LOW_BUDGET = {
  global: { totalTokens: 100, costUsd: 0.01 },
  byScope: { run: { totalTokens: 100, costUsd: 0.01 }, interview: { totalTokens: 0, costUsd: 0 } },
  limits: { globalBudget: 100000, perRunBudget: 0 }
}

function routes(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return defaultRoutes({
    'GET /api/model-profiles': VALID_MODEL_PROFILES,
    'GET /api/budget': LOW_BUDGET,
    ...overrides
  })
}

function runRow(id: string, name: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    status,
    questionnaire_id: 'qn1',
    config_json: JSON.stringify({ model: 'm1', temperature: 1, seeds: [0] }),
    response_count: 1,
    invalid_count: 0,
    created_at: '2026-08-06 10:00:00',
    ...extra
  }
}

/** Minimal stub set so opening a run's detail from the overview does not 404. */
function detailRoutesFor(run: Record<string, unknown>): Record<string, unknown> {
  const id = run.id as string
  return {
    [`GET /api/runs/${id}`]: { run, responses: [], usage: {}, staleVersions: { questionnaire: null, personas: [] } },
    [`GET /api/runs/${id}/progress`]: {
      status: run.status,
      providers: [],
      staleVersions: { questionnaire: null, personas: [] },
      totalCells: 4,
      done: 1,
      invalid: 0,
      abstained: 0,
      avgLatencyMs: 0,
      usage: {}
    },
    [`GET /api/runs/${id}/results`]: {
      totalResponses: 0,
      cellIndexPresent: true,
      invalidCount: 0,
      abstainedCount: 0,
      duplicateResponseCount: 0,
      questions: [],
      personas: []
    },
    [`GET /api/runs/${id}/evaluations`]: []
  }
}

describe('routing to the overview', () => {
  it('is the default tab for an empty hash', async () => {
    dom = loadAppDom({ routes: routes({ 'GET /api/runs': [] }) })
    await dom.boot()
    expect(dom.document.getElementById('tab-overview')!.className).toContain('active')
    expect(dom.document.querySelector('[data-tab="overview"]')!.className).toContain('active')
  })

  it('still honours #projects directly', async () => {
    dom = loadAppDom({ routes: routes({ 'GET /api/runs': [] }) })
    dom.window.location.hash = '#projects'
    await dom.boot()
    expect(dom.document.getElementById('tab-projects')!.className).toContain('active')
  })

  it('restores #overview explicitly too', async () => {
    dom = loadAppDom({ routes: routes({ 'GET /api/runs': [] }) })
    dom.window.location.hash = '#overview'
    await dom.boot()
    expect(dom.document.getElementById('tab-overview')!.className).toContain('active')
  })
})

describe('running and stalled measurements', () => {
  it('says so out loud when nothing is running or stalled', async () => {
    dom = loadAppDom({ routes: routes({ 'GET /api/runs': [runRow('r1', 'Kész', 'completed')] }) })
    await dom.boot()
    expect(dom.document.getElementById('tab-overview')!.textContent).toMatch(/nincs.*mérés/i)
  })

  it('shows a card per running/paused/budget_exhausted run, with a resume control where relevant', async () => {
    const running = runRow('r1', 'Éppen fut', 'running')
    const paused = runRow('r2', 'Megszakadt', 'paused')
    const exhausted = runRow('r3', 'Kifogyott', 'budget_exhausted')
    dom = loadAppDom({
      routes: routes({
        'GET /api/runs': [running, paused, exhausted],
        ...detailRoutesFor(running),
        ...detailRoutesFor(paused),
        ...detailRoutesFor(exhausted)
      })
    })
    await dom.boot()
    const overview = dom.document.getElementById('tab-overview')!
    expect(overview.textContent).toContain('Éppen fut')
    expect(overview.textContent).toContain('Megszakadt')
    expect(overview.textContent).toContain('Kifogyott')
    expect(
      dom.document.querySelector('#tab-overview [data-run-card="r2"] [data-action="resume"]')
    ).not.toBeNull()
    expect(
      dom.document.querySelector('#tab-overview [data-run-card="r3"] [data-action="resume"]')
    ).not.toBeNull()
  })

  it('opens a run detail when its card is clicked', async () => {
    const running = runRow('r1', 'Éppen fut', 'running')
    dom = loadAppDom({ routes: routes({ 'GET /api/runs': [running], ...detailRoutesFor(running) }) })
    await dom.boot()
    dom.document.querySelector('#tab-overview [data-run-card="r1"]')!.click()
    await dom.settle()
    expect(dom.document.getElementById('runDetailView')!.style.display).toBe('block')
  })
})

describe('recently completed runs', () => {
  it('lists at most the 5 most recent completed runs, most recent first', async () => {
    const runs = Array.from({ length: 6 }, (_, i) =>
      runRow(`c${i}`, `Futás ${i}`, 'completed', { created_at: `2026-08-0${6 - i} 10:00:00` })
    )
    dom = loadAppDom({ routes: routes({ 'GET /api/runs': runs }) })
    await dom.boot()
    const overview = dom.document.getElementById('tab-overview')!.textContent!
    for (let i = 0; i < 5; i++) expect(overview).toContain(`Futás ${i}`)
    expect(overview).not.toContain('Futás 5')
  })

  it('says so out loud when there are no completed runs yet', async () => {
    dom = loadAppDom({ routes: routes({ 'GET /api/runs': [] }) })
    await dom.boot()
    expect(dom.document.getElementById('tab-overview')!.textContent).toMatch(/nincs.*(befejezett|kész)/i)
  })

  it('opens a run detail when a recent-run row is clicked', async () => {
    const completed = runRow('c1', 'Legutóbbi', 'completed')
    dom = loadAppDom({ routes: routes({ 'GET /api/runs': [completed], ...detailRoutesFor(completed) }) })
    await dom.boot()
    const row = dom.document.querySelector('#tab-overview [data-run="c1"]')
    expect(row).not.toBeNull()
    row!.click()
    await dom.settle()
    expect(dom.document.getElementById('runDetailView')!.style.display).toBe('block')
  })
})

describe('warnings', () => {
  it('says so out loud when there is nothing to warn about', async () => {
    dom = loadAppDom({ routes: routes({ 'GET /api/runs': [] }) })
    await dom.boot()
    const warnings = dom.document.getElementById('overviewWarnings')!
    expect(warnings.textContent).toMatch(/nincs/i)
  })

  it('names models with no valid calibration profile and what that costs', async () => {
    dom = loadAppDom({
      routes: routes({
        'GET /api/runs': [],
        'GET /api/model-profiles': [
          { model: 'm1', label: 'Modell 1', status: 'missing', reasons: [], summary: null, profile: null },
          { model: 'm2', label: 'Modell 2', status: 'stale', reasons: ['lejárt'], summary: null, profile: null }
        ]
      })
    })
    await dom.boot()
    const warnings = dom.document.getElementById('overviewWarnings')!.textContent!
    expect(warnings).toContain('Modell 1')
    expect(warnings).toContain('Modell 2')
    expect(warnings).toMatch(/nincs mihez viszonyítani/i)
  })

  it('flags a run made with a since-superseded persona or questionnaire version', async () => {
    const completed = runRow('c1', 'Régi verzióval', 'completed')
    dom = loadAppDom({
      routes: routes({
        'GET /api/runs': [completed],
        [`GET /api/runs/c1/progress`]: {
          status: 'completed',
          providers: [],
          staleVersions: { questionnaire: { used: 1, latest: 2 }, personas: [] },
          totalCells: 4,
          done: 4,
          invalid: 0,
          abstained: 0,
          avgLatencyMs: 0,
          usage: {}
        },
        [`GET /api/runs/c1`]: {
          run: completed,
          responses: [],
          usage: {},
          staleVersions: { questionnaire: { used: 1, latest: 2 }, personas: [] }
        }
      })
    })
    await dom.boot()
    const warnings = dom.document.getElementById('overviewWarnings')!.textContent!
    expect(warnings).toContain('Régi verzióval')
    expect(warnings).toMatch(/elavult/i)
  })

  it('warns when the global token budget is above 80%', async () => {
    dom = loadAppDom({
      routes: routes({
        'GET /api/runs': [],
        'GET /api/budget': {
          global: { totalTokens: 85000, costUsd: 8 },
          byScope: { run: { totalTokens: 85000, costUsd: 8 }, interview: { totalTokens: 0, costUsd: 0 } },
          limits: { globalBudget: 100000, perRunBudget: 0 }
        }
      })
    })
    await dom.boot()
    const warnings = dom.document.getElementById('overviewWarnings')!.textContent!
    expect(warnings).toMatch(/80%/)
  })

  it('does not warn about the budget when it is under 80%', async () => {
    dom = loadAppDom({ routes: routes({ 'GET /api/runs': [] }) })
    await dom.boot()
    const warnings = dom.document.getElementById('overviewWarnings')!.textContent!
    expect(warnings).not.toMatch(/80%/)
  })
})

describe('quick actions', () => {
  it('jumps to Futtatások with the create form ready to open', async () => {
    dom = loadAppDom({ routes: routes({ 'GET /api/runs': [] }) })
    await dom.boot()
    dom.document.getElementById('overviewQuickRun')!.click()
    await dom.settle()
    expect(dom.document.getElementById('tab-runs')!.className).toContain('active')
    expect(dom.window.location.hash).toBe('#runs')
  })

  it('jumps to Interjúk', async () => {
    dom = loadAppDom({ routes: routes({ 'GET /api/runs': [] }) })
    await dom.boot()
    dom.document.getElementById('overviewQuickInterview')!.click()
    await dom.settle()
    expect(dom.document.getElementById('tab-interviews')!.className).toContain('active')
    expect(dom.window.location.hash).toBe('#interviews')
  })

  it('jumps to Modellek for calibration', async () => {
    dom = loadAppDom({ routes: routes({ 'GET /api/runs': [] }) })
    await dom.boot()
    dom.document.getElementById('overviewQuickCalibration')!.click()
    await dom.settle()
    expect(dom.document.getElementById('tab-models')!.className).toContain('active')
    expect(dom.window.location.hash).toBe('#models')
  })
})

// Code-review defect #1: renderOverviewWarnings (public/overview.js) treats "no
// warning produced" as "all clear", but state.modelProfiles, a run's
// staleVersions and state.budgetData are all just as empty when their fetch
// FAILED as when everything is genuinely fine. The two must read differently.
describe('warnings degrade honestly when a source could not be checked (code-review defect #1)', () => {
  it('says the model calibration state could not be checked, not that nothing is wrong', async () => {
    dom = loadAppDom({ routes: routes({ 'GET /api/runs': [], 'GET /api/model-profiles': undefined }) })
    await dom.boot()
    const warnings = dom.document.getElementById('overviewWarnings')!.textContent!
    expect(warnings).not.toMatch(/nincs figyelmeztetés/i)
    expect(warnings).toMatch(/nem ellenőr/i)
  })

  it('says the budget could not be checked, not that it is fine', async () => {
    dom = loadAppDom({ routes: routes({ 'GET /api/runs': [], 'GET /api/budget': undefined }) })
    await dom.boot()
    const warnings = dom.document.getElementById('overviewWarnings')!.textContent!
    expect(warnings).not.toMatch(/nincs figyelmeztetés/i)
    expect(warnings).toMatch(/nem ellenőr/i)
  })

  it("says a run's version staleness could not be checked, not that it is current", async () => {
    const completed = runRow('c1', 'Ellenőrizhetetlen', 'completed')
    dom = loadAppDom({
      routes: routes({
        'GET /api/runs': [completed],
        'GET /api/runs/c1/progress': undefined
      })
    })
    await dom.boot()
    const warnings = dom.document.getElementById('overviewWarnings')!.textContent!
    expect(warnings).not.toMatch(/nincs figyelmeztetés/i)
    expect(warnings).toMatch(/nem ellenőr/i)
  })
})

// Code-review defect #3: a `failed` run is in neither OVERVIEW_STALLED_STATUSES
// (running|paused|budget_exhausted) nor the recent-completed block
// (status === 'completed') — it silently disappears from Áttekintés even
// though runControlButtons already offers Folytatás for it.
describe('a failed run must not disappear from the overview (code-review defect #3)', () => {
  it('shows a failed run somewhere on Áttekintés, with its Folytatás control reachable', async () => {
    const failed = runRow('r1', 'Meghiúsult', 'failed')
    dom = loadAppDom({ routes: routes({ 'GET /api/runs': [failed], ...detailRoutesFor(failed) }) })
    await dom.boot()
    const overview = dom.document.getElementById('tab-overview')!.textContent!
    expect(overview).toContain('Meghiúsult')
    expect(
      dom.document.querySelector('#tab-overview [data-run-card="r1"] [data-action="resume"]')
    ).not.toBeNull()
  })
})

// Code-review defect #4: renderRunCard (public/runs-list.js) picks the live
// status (from the progress poll) for its BADGE, but passes the raw run row
// to runControlButtons, which reads run.status — the stale value from the
// /api/runs fetch. The overview reuses this same card.
describe('run-card controls follow the live status, not the stale row status (code-review defect #4)', () => {
  it('offers Folytatás, not Szünet, when the live progress says budget_exhausted for a row still marked running', async () => {
    const row = runRow('r1', 'Réginek jelzett', 'running')
    dom = loadAppDom({
      routes: routes({
        'GET /api/runs': [row],
        'GET /api/runs/r1/progress': {
          status: 'budget_exhausted',
          providers: [],
          staleVersions: { questionnaire: null, personas: [] },
          totalCells: 4,
          done: 4,
          invalid: 0,
          abstained: 0,
          avgLatencyMs: 0,
          usage: {}
        }
      })
    })
    await dom.boot()
    // budget_exhausted is a stalled status, so the live-status card shows up here
    const card = dom.document.querySelector('#tab-overview [data-run-card="r1"]')
    expect(card).not.toBeNull()
    expect(dom.document.querySelector('#tab-overview [data-run-card="r1"] [data-action="resume"]')).not.toBeNull()
    expect(dom.document.querySelector('#tab-overview [data-run-card="r1"] [data-action="pause"]')).toBeNull()
  })
})

// Issue #23: opening a run from the Áttekintés tab and pressing Vissza used to
// leave location.hash on '#overview' while the Futtatások pane was the one
// actually visible — a real browser reload or back/forward navigation would
// then snap the researcher onto a screen they were not looking at. The two
// entry points on this tab (the running/stalled card vs. the "legutóbbi
// befejezett" row) must land in the SAME kind of state; this suite does not
// prescribe which tab that ends up being — only that the hash and the visible
// tab agree with each other, and stay put on a subsequent re-route.
describe('Vissza after opening a run from Áttekintés (issue #23)', () => {
  function activeTabName(d: AppDom): string {
    const pane = d.document.querySelector('.tab-pane.active')
    const id = pane?.getAttribute('id') ?? ''
    return id.replace(/^tab-/, '')
  }

  /**
   * A genuine hashchange — not one produced by setHash()'s replaceState (the
   * harness no longer turns those into an event, per issue #21) — the kind a
   * browser reload or back/forward would fire for whatever the address bar
   * already says. If hash and visible tab are truly consistent, re-applying
   * that same route is a no-op; if it moves the researcher, they were not
   * consistent to begin with.
   */
  function fireGenuineHashchange(d: AppDom): void {
    const w = d.window as unknown as { dispatchEvent: (e: unknown) => boolean }
    w.dispatchEvent(new d.window.Event('hashchange', { bubbles: true }))
  }

  it('agree after the running/stalled card entry point', async () => {
    const running = runRow('r1', 'Éppen fut', 'running')
    dom = loadAppDom({ routes: routes({ 'GET /api/runs': [running], ...detailRoutesFor(running) }) })
    await dom.boot()
    dom.document.querySelector('#tab-overview [data-run-card="r1"]')!.click()
    await dom.settle()
    expect(dom.window.location.hash).toBe('#runs/r1')

    dom.document.getElementById('runDetailBackBtn')!.click()
    await dom.settle()

    const tabName = activeTabName(dom)
    // Assert on both the address bar AND the visible pane/nav — a fix that
    // only changes one of them is still half a fix.
    expect(dom.window.location.hash).toBe('#' + tabName)
    expect(dom.document.querySelector(`[data-tab="${tabName}"]`)!.className).toContain('active')

    fireGenuineHashchange(dom)
    await dom.settle()
    expect(activeTabName(dom)).toBe(tabName)
    expect(dom.window.location.hash).toBe('#' + tabName)
  })

  // Regression guard: this entry point already goes through
  // handleEntityClick (public/entity-view.js), which DOES set
  // state.activeTab — it must keep behaving exactly like this after a fix
  // for the card path above.
  it('agree after the "legutóbbi befejezett" row entry point (already correct — must stay correct)', async () => {
    const completed = runRow('c1', 'Legutóbbi', 'completed')
    dom = loadAppDom({ routes: routes({ 'GET /api/runs': [completed], ...detailRoutesFor(completed) }) })
    await dom.boot()
    dom.document.querySelector('#tab-overview [data-run="c1"]')!.click()
    await dom.settle()
    expect(dom.window.location.hash).toBe('#runs/c1')

    dom.document.getElementById('runDetailBackBtn')!.click()
    await dom.settle()

    const tabName = activeTabName(dom)
    expect(dom.window.location.hash).toBe('#' + tabName)
    expect(dom.document.querySelector(`[data-tab="${tabName}"]`)!.className).toContain('active')

    fireGenuineHashchange(dom)
    await dom.settle()
    expect(activeTabName(dom)).toBe(tabName)
    expect(dom.window.location.hash).toBe('#' + tabName)
  })
})

describe('no new server endpoint', () => {
  it('is built only from /api/runs, /api/model-profiles and /api/budget (plus the usual boot calls)', async () => {
    dom = loadAppDom({ routes: routes({ 'GET /api/runs': [runRow('r1', 'X', 'completed')] }) })
    await dom.boot()
    const KNOWN = [
      '/api/session',
      '/api/models',
      '/api/projects',
      '/api/personas',
      '/api/questionnaires',
      '/api/runs',
      '/api/interviews',
      '/api/budget',
      '/api/model-profiles'
    ]
    const unexpected = dom.calls
      .map((c) => c.url.split('?')[0]!)
      .filter((path) => !KNOWN.some((known) => path === known || path.startsWith(known + '/')))
    expect(unexpected).toEqual([])
  })
})
