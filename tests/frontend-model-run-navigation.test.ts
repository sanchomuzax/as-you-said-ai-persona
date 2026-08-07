import { describe, it, expect, afterEach } from 'vitest'
import { loadAppDom, defaultRoutes, type AppDom } from './helpers/load-app-dom.js'

/**
 * Issue #30: clicking the running-calibration indicator on the model page
 * shows content that immediately disappears. The issue's own hypothesis is
 * that the click switches view AND a concurrent progress re-render closes or
 * re-renders it — NOT taken as fact here. Empirically reproducing the click
 * followed by a progress tick / SSE event (below) shows the run detail stays
 * open exactly as it should; what does NOT happen is that
 * openRunDetail (public/run-view.js) ever closes the model detail view it was
 * opened from (public/model-view.js's openModelDetail closes every OTHER
 * detail view first, but the reverse direction has no such call) — so both
 * #modelDetailView and #runDetailView end up simultaneously display:block.
 * That is the concretely reproducible defect a real browser would show as
 * two full-page detail sections stacked on top of each other, which is a
 * plausible reading of "something flashed, then [the run detail] vanished
 * [under the still-visible model card]".
 */

let dom: AppDom | null = null
afterEach(() => {
  dom?.close()
  dom = null
})

const CAL_RUN = {
  id: 'cal-run-1',
  name: 'Kalibráció — m2',
  status: 'running',
  created_at: '2026-08-07 10:00:00',
  questionnaire_id: 'probe',
  config_json: JSON.stringify({ model: 'm2', temperature: 1, seeds: [0, 1], baselineArm: true, calibration: true }),
  response_count: 2,
  invalid_count: 0,
  total_cells: 4,
  done_cells: 2
}

function routes(): Record<string, unknown> {
  return defaultRoutes({
    'GET /api/model-profiles': [
      { model: 'm2', label: 'Modell 2', status: 'missing', reasons: [], summary: null, profile: null }
    ],
    'GET /api/questionnaires': [{ id: 'probe', name: 'Próba-kérdőív', questions: [] }],
    'GET /api/runs': [CAL_RUN],
    'GET /api/runs/cal-run-1': {
      run: CAL_RUN, responses: [], usage: {}, staleVersions: { questionnaire: null, personas: [] }
    },
    'GET /api/runs/cal-run-1/progress': {
      status: 'running', providers: [], staleVersions: { questionnaire: null, personas: [] },
      totalCells: 4, done: 2, invalid: 0, abstained: 0, avgLatencyMs: 0, usage: {}
    },
    'GET /api/runs/cal-run-1/results': {
      totalResponses: 0, cellIndexPresent: true, invalidCount: 0, abstainedCount: 0,
      duplicateResponseCount: 0, questions: [], personas: []
    },
    'GET /api/runs/cal-run-1/evaluations': []
  })
}

async function openCalibrationRunFromModelCard(d: AppDom): Promise<void> {
  d.document.querySelector('[data-model="m2"]')!.click()
  await d.settle()
  d.document.querySelector('[data-cal-run="cal-run-1"]')!.click()
  await d.settle()
}

describe('the run detail opened from a running-calibration indicator survives a concurrent update (issue #30)', () => {
  it('stays open, showing the same run, after a progress poll tick', async () => {
    dom = loadAppDom({ routes: routes() })
    await dom.boot()
    await openCalibrationRunFromModelCard(dom)
    expect(dom.document.getElementById('runDetailView')!.style.display).toBe('block')
    expect(dom.document.getElementById('runDetailTitle')!.textContent).toContain('Kalibráció — m2')

    const poll = (dom.window as unknown as { pollRunningProgress: () => Promise<void> }).pollRunningProgress
    await poll()
    await dom.settle()

    expect(dom.document.getElementById('runDetailView')!.style.display).toBe('block')
    expect(dom.document.getElementById('runDetailTitle')!.textContent).toContain('Kalibráció — m2')
  })

  it('stays open, showing the same run, after an SSE "status" event', async () => {
    dom = loadAppDom({ routes: routes() })
    await dom.boot()
    await openCalibrationRunFromModelCard(dom)

    dom.emitServerEvent('status', { runId: 'cal-run-1' })
    await dom.settle()

    expect(dom.document.getElementById('runDetailView')!.style.display).toBe('block')
    expect(dom.document.getElementById('runDetailTitle')!.textContent).toContain('Kalibráció — m2')
  })
})

describe('navigation is hash-based and survives a reload (issue #30)', () => {
  it('sets location.hash to #runs/<id> right after the click', async () => {
    dom = loadAppDom({ routes: routes() })
    await dom.boot()
    await openCalibrationRunFromModelCard(dom)
    expect(dom.window.location.hash).toBe('#runs/cal-run-1')
  })

  it('booting fresh at that hash lands on the same run detail', async () => {
    dom = loadAppDom({ routes: routes() })
    dom.window.location.hash = '#runs/cal-run-1'
    await dom.boot()
    expect(dom.document.getElementById('runDetailView')!.style.display).toBe('block')
    expect(dom.document.getElementById('runDetailTitle')!.textContent).toContain('Kalibráció — m2')
  })
})

// The concretely reproducible root cause found while testing the above:
// openRunDetail never closes #modelDetailView (unlike openModelDetail, which
// DOES close every other detail view before showing itself) — so navigating
// to a run from inside a model card leaves BOTH detail sections
// simultaneously display:block.
describe('opening a run’s detail from the model card closes the model detail view (issue #30 root cause)', () => {
  it('hides #modelDetailView once the run detail opens', async () => {
    dom = loadAppDom({ routes: routes() })
    await dom.boot()
    await openCalibrationRunFromModelCard(dom)

    expect(dom.document.getElementById('runDetailView')!.style.display).toBe('block')
    expect(dom.document.getElementById('modelDetailView')!.style.display, 'model detail view must close').toBe('none')
  })
})
