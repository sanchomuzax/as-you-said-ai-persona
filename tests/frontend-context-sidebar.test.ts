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
const RUNNING_RUN = {
  id: 'r1',
  name: 'Éppen fut',
  status: 'running',
  questionnaire_id: 'qn1',
  config_json: JSON.stringify({ model: 'm1', temperature: 1, seeds: [0] }),
  response_count: 3,
  invalid_count: 0,
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
const BUDGET = {
  global: { totalTokens: 5000, costUsd: 0.5 },
  byScope: {
    measurement: { totalTokens: 4000, costUsd: 0.4 },
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
      '/api/budget'
    ]
    const unexpected = dom.calls
      .map((c) => c.url.split('?')[0]!)
      .filter((path) => !KNOWN.some((known) => path === known || path.startsWith(known + '/')))
    expect(unexpected).toEqual([])
  })
})
