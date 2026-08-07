import { describe, it, expect, afterEach } from 'vitest'
import { loadAppDom, defaultRoutes, type AppDom } from './helpers/load-app-dom.js'

/**
 * Permanent context sidebar (issue #19): `#contextSidebar`, visible on every
 * tab, showing the active project, its personas, the one running measurement
 * (if any) and the token budget. Built entirely from state/endpoints the app
 * already fetches — no new server route.
 */

let dom: AppDom | null = null

afterEach(() => {
  dom?.close()
  dom = null
})

const PROJECT = { id: 'p1', name: 'Startlap', applicationDomain: 'Hírportál', targetPopulation: '18-65' }
const OTHER_PROJECT = { id: 'p2', name: 'Másik projekt' }
const PERSONA = { id: 'per1', projectId: 'p1', name: 'Anna', demographics: { kor: 34 }, version: 1, isLatest: true }
// Issue #22: GET /api/runs now carries total_cells/done_cells directly on
// every row (src/server.ts, one SQL statement) — a run's live progress is no
// longer polled automatically at boot (only the 5s timer does that, and only
// for a currently-running row), so the row itself is what an initial render
// must show. Values match RUN_PROGRESS below on purpose: a poll that reports
// the identical numbers must be a genuine no-op (code-review defect #8).
const RUNNING_RUN = {
  id: 'r1',
  name: 'Éppen fut',
  status: 'running',
  questionnaire_id: 'qn1',
  config_json: JSON.stringify({ model: 'm1', temperature: 1, seeds: [0] }),
  response_count: 3,
  invalid_count: 0,
  total_cells: 10,
  done_cells: 3,
  created_at: '2026-08-06 10:00:00'
}
const RUN_PROGRESS = {
  status: 'running',
  providers: [],
  staleVersions: { questionnaire: null, personas: [] },
  totalCells: 10,
  done: 3,
  invalid: 0,
  abstained: 0,
  avgLatencyMs: 90,
  usage: { promptTokens: 100, completionTokens: 30, totalTokens: 130, cachedTokens: 0, costUsd: 0.002 }
}
// The server only ever emits byScope: { run, interview } (src/lib/budget.ts's
// usageByScope()) — there is no "measurement" scope key.
const BUDGET = {
  global: { totalTokens: 5000, costUsd: 0.5 },
  byScope: {
    run: { totalTokens: 4000, costUsd: 0.4 },
    interview: { totalTokens: 1000, costUsd: 0.1 }
  },
  limits: { globalBudget: 100000, perRunBudget: 0 }
}

function routes(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return defaultRoutes({
    'GET /api/projects': [PROJECT, OTHER_PROJECT],
    'GET /api/personas': [PERSONA],
    'GET /api/budget': BUDGET,
    ...overrides
  })
}

async function selectProject(d: AppDom, selectId = 'runProjectSelect', id = 'p1'): Promise<void> {
  const select = d.document.getElementById(selectId)!
  select.value = id
  select.dispatchEvent(new d.window.Event('change', { bubbles: true }))
  await d.settle()
}

describe('sidebar presence and accessibility shell', () => {
  it('is present on every tab, labelled as an aside landmark', async () => {
    dom = loadAppDom({ routes: routes() })
    await dom.boot()
    const aside = dom.document.getElementById('contextSidebar')!
    expect(aside).not.toBeNull()
    expect(aside.getAttribute('aria-label')).toBeTruthy()

    dom.document.querySelector('[data-tab="interviews"]')!.click()
    await dom.settle()
    expect(dom.document.getElementById('contextSidebar')!.isConnected).toBe(true)
  })

  it('gives its clickable rows a role, tabindex and accessible label', async () => {
    dom = loadAppDom({ routes: routes() })
    await dom.boot()
    await selectProject(dom)
    const rows = dom.document.querySelectorAll('#contextSidebar [role="button"]')
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.getAttribute('tabindex')).toBe('0')
      expect(row.getAttribute('aria-label')).toBeTruthy()
    }
  })

  it('announces the running-measurement progress politely', async () => {
    dom = loadAppDom({ routes: routes() })
    await dom.boot()
    const live = dom.document.querySelector('#contextSidebar [aria-live]')
    expect(live).not.toBeNull()
    expect(live!.getAttribute('aria-live')).toBe('polite')
  })
})

describe('active project selector', () => {
  it('offers every project and syncs the existing per-tab selects when changed', async () => {
    dom = loadAppDom({ routes: routes() })
    await dom.boot()
    const select = dom.document.querySelector('#contextSidebar select')!
    expect(select.textContent).toContain('Startlap')
    expect(select.textContent).toContain('Másik projekt')

    select.value = 'p1'
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    await dom.settle()

    expect((dom.document.getElementById('runProjectSelect')!).value).toBe('p1')
    expect((dom.document.getElementById('personaProjectSelect')!).value).toBe('p1')
  })

  it('stays in sync when the project is changed from an existing per-tab dropdown', async () => {
    dom = loadAppDom({ routes: routes() })
    await dom.boot()
    await selectProject(dom, 'runProjectSelect', 'p1')
    const sidebarSelect = dom.document.querySelector('#contextSidebar select')!
    expect(sidebarSelect.value).toBe('p1')
  })
})

describe('the project personas list', () => {
  it('lists the personas of the active project as openable rows', async () => {
    dom = loadAppDom({ routes: routes() })
    await dom.boot()
    await selectProject(dom)
    const row = dom.document.querySelector('#contextSidebar [data-entity="personas"]')
    expect(row).not.toBeNull()
    expect(row!.textContent).toContain('Anna')
  })

  it('opens the persona detail view on click', async () => {
    dom = loadAppDom({
      routes: routes({
        'GET /api/personas/per1': PERSONA,
        'GET /api/personas/per1/versions': [PERSONA]
      })
    })
    await dom.boot()
    await selectProject(dom)
    dom.document.querySelector('#contextSidebar [data-entity="personas"]')!.click()
    await dom.settle()
    expect(dom.document.getElementById('entityDetailView')!.style.display).toBe('block')
    expect(dom.document.getElementById('entityDetailTitle')!.textContent).toContain('Anna')
  })
})

describe('the running measurement', () => {
  it('says so out loud when nothing is running', async () => {
    dom = loadAppDom({ routes: routes({ 'GET /api/runs': [] }) })
    await dom.boot()
    expect(dom.document.getElementById('contextSidebar')!.textContent).toMatch(/nincs futó mérés/i)
  })

  it('shows the running run, its progress, and opens it on click', async () => {
    dom = loadAppDom({
      routes: routes({
        'GET /api/runs': [RUNNING_RUN],
        'GET /api/runs/r1/progress': RUN_PROGRESS,
        'GET /api/runs/r1': {
          run: RUNNING_RUN,
          responses: [],
          usage: RUN_PROGRESS.usage,
          staleVersions: RUN_PROGRESS.staleVersions
        },
        'GET /api/runs/r1/results': {
          totalResponses: 0,
          cellIndexPresent: true,
          invalidCount: 0,
          abstainedCount: 0,
          duplicateResponseCount: 0,
          questions: [],
          personas: []
        },
        'GET /api/runs/r1/evaluations': []
      })
    })
    await dom.boot()
    const sidebar = dom.document.getElementById('contextSidebar')!
    expect(sidebar.textContent).toContain('Éppen fut')
    // done/total progress must be legible from the text, not only a bar width
    expect(sidebar.textContent).toMatch(/3/)
    expect(sidebar.textContent).toMatch(/10/)

    const row = dom.document.querySelector('#contextSidebar [data-run]')
    expect(row).not.toBeNull()
    row!.click()
    await dom.settle()
    expect(dom.document.getElementById('runDetailView')!.style.display).toBe('block')
  })

  it('does not start a second polling timer for its own updates', async () => {
    dom = loadAppDom({ routes: routes({ 'GET /api/runs': [RUNNING_RUN], 'GET /api/runs/r1/progress': RUN_PROGRESS }) })
    const w = dom.window as unknown as { setInterval: (...args: unknown[]) => number }
    let intervalCalls = 0
    const original = w.setInterval
    w.setInterval = ((...args: unknown[]) => {
      intervalCalls++
      return (original as (...a: unknown[]) => number)(...args)
    }) as typeof w.setInterval
    await dom.boot()
    // The app already starts exactly one polling timer (progressPollTimer); the
    // sidebar must ride along on it rather than starting its own.
    expect(intervalCalls).toBe(1)
  })
})

describe('token budget', () => {
  it('shows the global usage against the limit, split by scope', async () => {
    dom = loadAppDom({ routes: routes() })
    await dom.boot()
    const sidebar = dom.document.getElementById('contextSidebar')!.textContent!
    expect(sidebar).toMatch(/mérés/i)
    expect(sidebar).toMatch(/interjú/i)
  })

  it('builds its data from endpoints the app already calls, no new server route', async () => {
    dom = loadAppDom({ routes: routes({ 'GET /api/runs': [] }) })
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
      // Fetched at boot by refreshModelList() (public/model-view.js), unrelated
      // to the sidebar — predates issue #19. Left out of the "no new endpoint"
      // check would fail the test for the wrong reason.
      '/api/model-profiles'
    ]
    const unexpected = dom.calls
      .map((c) => c.url.split('?')[0]!)
      .filter((path) => !KNOWN.some((known) => path === known || path.startsWith(known + '/')))
    expect(unexpected).toEqual([])
  })

  // Code-review defect #7: on a failed fetch, updateBudgetBar's .catch() never
  // calls renderContextSidebarBudget — the section is stuck on its initial
  // "Betöltés..." placeholder forever, unlike the header widget, which degrades
  // to "—".
  it('degrades to a stated unknown instead of being stuck on Betöltés... when /api/budget fails (defect #7)', async () => {
    dom = loadAppDom({ routes: routes({ 'GET /api/runs': [], 'GET /api/budget': undefined }) })
    await dom.boot()
    const budgetSection = dom.document.getElementById('contextSidebarBudget')!.textContent!
    expect(budgetSection).not.toMatch(/betöltés/i)
  })
})

// Code-review defect #2: focus-return.js's restoreDetailFocus uses
// document.querySelector, which matches the FIRST element in document order.
// The sidebar (personas) and the overview (runs) now render rows carrying the
// exact same data-entity-id / data-run-card values EARLIER in the document
// than #personasList / #runsList — so closing a detail opened from the real
// list silently focuses the sidebar/overview's copy instead.
describe('focus return is not hijacked by a duplicate row elsewhere in the DOM (code-review defect #2)', () => {
  it('returns focus to the row inside #personasList, not the sidebar copy', async () => {
    dom = loadAppDom({
      routes: routes({
        'GET /api/personas/per1': PERSONA,
        'GET /api/personas/per1/versions': [PERSONA]
      })
    })
    await dom.boot()
    await selectProject(dom, 'personaProjectSelect', 'p1')
    // Both containers now render the identical data-entity-id — that duplication
    // is the precondition for the bug, not something to work around.
    expect(dom.document.querySelector('#contextSidebarPersonas [data-entity-id="per1"]')).not.toBeNull()
    dom.document.querySelector('#personasList [data-entity-id="per1"]')!.click()
    await dom.settle()
    dom.document.getElementById('entityDetailBackBtn')!.click()
    await dom.settle()

    const listRow = dom.document.querySelector('#personasList [data-entity-id="per1"]')
    const sidebarRow = dom.document.querySelector('#contextSidebarPersonas [data-entity-id="per1"]')
    expect(dom.document.activeElement).toBe(listRow)
    expect(dom.document.activeElement).not.toBe(sidebarRow)
  })

  it('returns focus to the card inside #runsList, not the overview copy', async () => {
    const paused = {
      id: 'r1',
      name: 'Szünetel',
      status: 'paused',
      questionnaire_id: 'qn1',
      config_json: JSON.stringify({ model: 'm1', temperature: 1, seeds: [0] }),
      response_count: 1,
      invalid_count: 0,
      created_at: '2026-08-06 10:00:00'
    }
    dom = loadAppDom({
      routes: routes({
        'GET /api/runs': [paused],
        'GET /api/runs/r1/progress': {
          status: 'paused',
          providers: [],
          staleVersions: { questionnaire: null, personas: [] },
          totalCells: 4,
          done: 1,
          invalid: 0,
          abstained: 0,
          avgLatencyMs: 0,
          usage: {}
        },
        'GET /api/runs/r1': { run: paused, responses: [], usage: {}, staleVersions: { questionnaire: null, personas: [] } },
        'GET /api/runs/r1/results': {
          totalResponses: 0,
          cellIndexPresent: true,
          invalidCount: 0,
          abstainedCount: 0,
          duplicateResponseCount: 0,
          questions: [],
          personas: []
        },
        'GET /api/runs/r1/evaluations': []
      })
    })
    await dom.boot()
    // 'paused' is a stalled status, so the overview's card duplicates this one.
    expect(dom.document.querySelector('#overviewRunningList [data-run-card="r1"]')).not.toBeNull()
    dom.document.querySelector('#runsList [data-run-card="r1"]')!.click()
    await dom.settle()
    dom.document.getElementById('runDetailBackBtn')!.click()
    await dom.settle()

    const listCard = dom.document.querySelector('#runsList [data-run-card="r1"]')
    const overviewCard = dom.document.querySelector('#overviewRunningList [data-run-card="r1"]')
    expect(dom.document.activeElement).toBe(listCard)
    expect(dom.document.activeElement).not.toBe(overviewCard)
  })
})

// Code-review defects #5/#6: the sidebar's own project-select handler
// (context-sidebar.js) copied runProjectSelect's change handler, which never
// touched the interview list — and on CLEARING the project, only resets
// runPersonas' checkboxes, never repainting #personasList or #interviewPersona.
describe('sidebar project switch keeps every dependent list in sync', () => {
  it('requests the interview list for the newly selected project (defect #5)', async () => {
    dom = loadAppDom({ routes: routes() })
    await dom.boot()
    const before = dom.calls.length
    const select = dom.document.querySelector('#contextSidebar select')!
    select.value = 'p1'
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    await dom.settle()
    const urls = dom.calls.slice(before).map((c) => c.url)
    expect(urls.some((u) => u.startsWith('/api/interviews?project=p1'))).toBe(true)
  })

  it('clears stale personas from #personasList and #interviewPersona when the project is cleared (defect #6)', async () => {
    dom = loadAppDom({ routes: routes() })
    await dom.boot()
    const select = dom.document.querySelector('#contextSidebar select')!
    select.value = 'p1'
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    await dom.settle()
    expect(dom.document.getElementById('personasList')!.textContent).toContain('Anna')
    expect(dom.document.getElementById('interviewPersona')!.textContent).toContain('Anna')

    select.value = ''
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    await dom.settle()

    expect(dom.document.getElementById('personasList')!.textContent).not.toContain('Anna')
    expect(dom.document.getElementById('interviewPersona')!.textContent).not.toContain('Anna')
  })
})

// Code-review defect #8: renderContextSidebarRunning unconditionally reassigns
// innerHTML on every poll tick, even when the data has not changed — which
// destroys and rebuilds the focused row's DOM node, and with it, focus itself.
describe('the running-measurement region does not blow away focus on an unchanged poll (code-review defect #8)', () => {
  it('keeps focus on the row, and leaves the markup untouched, across a poll with identical data', async () => {
    dom = loadAppDom({ routes: routes({ 'GET /api/runs': [RUNNING_RUN], 'GET /api/runs/r1/progress': RUN_PROGRESS }) })
    await dom.boot()
    const container = dom.document.getElementById('contextSidebarRunning')!
    const before = container.innerHTML
    const row = dom.document.querySelector('#contextSidebarRunning [data-run="r1"]')!
    row.focus()
    expect(dom.document.activeElement).toBe(row)

    const w = dom.window as unknown as { pollRunningProgress: (includeAll?: boolean) => Promise<void> }
    await w.pollRunningProgress(true)
    await dom.settle()

    expect(container.innerHTML).toBe(before)
    expect(row.isConnected).toBe(true)
    expect(dom.document.activeElement).toBe(row)
  })
})
