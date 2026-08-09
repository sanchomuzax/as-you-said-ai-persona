import { describe, it, expect, afterEach } from 'vitest'
import { loadAppDom, defaultRoutes, type AppDom } from './helpers/load-app-dom.js'

/**
 * Issue #29: a running calibration shows almost nothing (just a tiny "fut"
 * label) and can be started again for the SAME model while one is already
 * running — double cost, plus the concurrency risk from issue #16. The
 * Modellek tab was reworked in PR #25 (f29b3e7): the calibration workflow now
 * lives ON the model card (public/model-card.js's renderCalibrationWorkflow),
 * so these tests target that current structure, not the pre-#25 tab-level
 * form.
 */

let dom: AppDom | null = null
afterEach(() => {
  dom?.close()
  dom = null
})

/** A calibration run for m2, as GET /api/runs now serves it (issue #22's
 * enriched fields — total_cells/done_cells/usage — live on the row itself). */
function calRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cal-run-1',
    name: 'Kalibráció — m2',
    status: 'running',
    created_at: '2026-08-07 10:00:00',
    questionnaire_id: 'probe',
    config_json: JSON.stringify({ model: 'm2', temperature: 1, seeds: [0, 1], baselineArm: true, calibration: true }),
    response_count: 3,
    invalid_count: 0,
    abstained_count: 0,
    total_cells: 8,
    done_cells: 3,
    stale_versions: 0,
    prompt_tokens: 900,
    completion_tokens: 300,
    cached_tokens: 0,
    total_tokens: 1200,
    cost_usd: 0.05,
    ...overrides
  }
}

function detailRoutesFor(run: Record<string, unknown>): Record<string, unknown> {
  const id = run['id'] as string
  return {
    [`GET /api/runs/${id}`]: { run, responses: [], usage: {}, staleVersions: { questionnaire: null, personas: [] } },
    [`GET /api/runs/${id}/progress`]: {
      status: run['status'],
      providers: [],
      staleVersions: { questionnaire: null, personas: [] },
      totalCells: run['total_cells'],
      done: run['done_cells'],
      invalid: 0,
      abstained: 0,
      avgLatencyMs: 90,
      usage: {
        promptTokens: run['prompt_tokens'],
        completionTokens: run['completion_tokens'],
        totalTokens: run['total_tokens'],
        cachedTokens: run['cached_tokens'],
        costUsd: run['cost_usd']
      }
    },
    [`GET /api/runs/${id}/results`]: {
      totalResponses: 0, cellIndexPresent: true, invalidCount: 0, abstainedCount: 0,
      duplicateResponseCount: 0, questions: [], personas: []
    },
    [`GET /api/runs/${id}/evaluations`]: []
  }
}

function routes(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return defaultRoutes({
    'GET /api/model-profiles': [
      { model: 'm1', label: 'Modell 1', status: 'missing', reasons: [], summary: null, profile: null },
      { model: 'm2', label: 'Modell 2', status: 'missing', reasons: [], summary: null, profile: null }
    ],
    'GET /api/questionnaires': [{
      id: 'probe', name: 'Próba-kérdőív', version: 1, isCalibrationProbe: true, questions: []
    }],
    'GET /api/runs': [],
    ...overrides
  })
}

describe('a running calibration blocks re-launching for the SAME model (issue #29)', () => {
  it('disables the launch control for a model with a running calibration, and explains why', async () => {
    const running = calRun()
    dom = loadAppDom({ routes: routes({ 'GET /api/runs': [running], ...detailRoutesFor(running) }) })
    await dom.boot()
    dom.document.querySelector('[data-model="m2"]')!.click()
    await dom.settle()

    const body = dom.document.getElementById('modelDetailBody')!
    const submitBtn = dom.document.querySelector('#modelDetailBody .model-card-calibrate-form button[type="submit"]')
    // Either disabled, or (if the fix removes the launch form entirely while
    // running) simply absent — either way, an enabled launch control must not
    // coexist with a running calibration for this model.
    if (submitBtn) expect(submitBtn.disabled, 'launch button must be disabled while running').toBe(true)
    expect(body.textContent).toMatch(/már fut kalibráció|előbb fejeződjön be|állítsd le|fut.*kalibráció.*ehhez/i)
  })

  it('does NOT block launching a DIFFERENT model’s calibration while m2’s is running', async () => {
    const running = calRun()
    dom = loadAppDom({ routes: routes({ 'GET /api/runs': [running], ...detailRoutesFor(running) }) })
    await dom.boot()
    dom.document.querySelector('[data-model="m1"]')!.click()
    await dom.settle()

    const submitBtn = dom.document.querySelector('#modelDetailBody .model-card-calibrate-form button[type="submit"]')
    expect(submitBtn, 'm1 must still offer a launch control').not.toBeNull()
    expect(submitBtn!.disabled).toBe(false)
  })
})

describe('a running calibration shows real progress, not just a status word (issue #29)', () => {
  it('shows done/total cells with a percentage, and the tokens/cost spent so far, from the enriched list row alone', async () => {
    const running = calRun()
    dom = loadAppDom({ routes: routes({ 'GET /api/runs': [running], ...detailRoutesFor(running) }) })
    await dom.boot()
    dom.document.querySelector('[data-model="m2"]')!.click()
    await dom.settle()

    const text = dom.document.getElementById('modelDetailBody')!.textContent!.replace(/\s/g, '')
    // done=3, total=8 -> 37.5% (or "3/8" rendered directly) — either is fine,
    // but the raw counts must be legible, not just a "fut" label.
    expect(text).toContain('3')
    expect(text).toContain('8')
    expect(text).toContain('1200') // total tokens
    expect(text).toContain('0.0500') // cost, formatCost's 4-decimal convention
  })

  it('shows elapsed time since the calibration started', async () => {
    const running = calRun()
    dom = loadAppDom({ routes: routes({ 'GET /api/runs': [running], ...detailRoutesFor(running) }) })
    await dom.boot()
    dom.document.querySelector('[data-model="m2"]')!.click()
    await dom.settle()

    const text = dom.document.getElementById('modelDetailBody')!.textContent!
    // Duration wording (minutes/hours/seconds/"running for") — the exact
    // phrasing is the implementer's choice; nothing like this exists in the
    // card at all today.
    expect(text).toMatch(/perc|óra|másodperc|ideje fut|eltelt/i)
  })

  it('updates from the SAME progress data every other running run uses — no new endpoint, no second timer', async () => {
    const running = calRun()
    dom = loadAppDom({ routes: routes({ 'GET /api/runs': [running], ...detailRoutesFor(running) }) })

    const w = dom.window as unknown as { setInterval: (...args: unknown[]) => number }
    let intervalCalls = 0
    const original = w.setInterval
    w.setInterval = ((...args: unknown[]) => {
      intervalCalls++
      return (original as (...a: unknown[]) => number)(...args)
    }) as typeof w.setInterval

    await dom.boot()
    dom.document.querySelector('[data-model="m2"]')!.click()
    await dom.settle()
    // The app already starts exactly one polling timer; the model card must
    // ride along on it, not start its own.
    expect(intervalCalls).toBe(1)

    const before = dom.calls.length
    const pollFn = (dom.window as unknown as { pollRunningProgress: () => Promise<void> }).pollRunningProgress
    await pollFn()
    await dom.settle()
    const urls = dom.calls.slice(before).map((c) => c.url.split('?')[0]!)
    const KNOWN = ['/api/runs', '/api/runs/cal-run-1/progress', '/api/model-profiles', '/api/questionnaires', '/api/budget']
    const unexpected = urls.filter((u) => !KNOWN.some((known) => u === known || u.startsWith(known + '/')))
    expect(unexpected).toEqual([])
  })
})

describe('the running calibration card offers a stop control and a way into the full run detail (issue #29)', () => {
  it('offers a stop control for the running calibration, on the model card', async () => {
    const running = calRun()
    dom = loadAppDom({ routes: routes({ 'GET /api/runs': [running], ...detailRoutesFor(running) }) })
    await dom.boot()
    dom.document.querySelector('[data-model="m2"]')!.click()
    await dom.settle()

    const stopBtn = dom.document.querySelector('#modelDetailBody [data-action="stop"][data-run="cal-run-1"]')
    expect(stopBtn, 'a stop control scoped to the model card').not.toBeNull()
  })

  it('opens the full run detail (#runs/<id>) from the card', async () => {
    const running = calRun()
    dom = loadAppDom({ routes: routes({ 'GET /api/runs': [running], ...detailRoutesFor(running) }) })
    await dom.boot()
    dom.document.querySelector('[data-model="m2"]')!.click()
    await dom.settle()
    dom.document.querySelector('#modelDetailBody [data-cal-run="cal-run-1"]')!.click()
    await dom.settle()
    expect(dom.window.location.hash).toBe('#runs/cal-run-1')
    expect(dom.document.getElementById('runDetailView')!.style.display).toBe('block')
  })

  it.each(['paused', 'budget_exhausted'])('offers a working Resume control for a %s calibration without navigating away', async (status) => {
    const resumable = calRun({ status })
    dom = loadAppDom({
      routes: routes({
        'GET /api/runs': [resumable],
        'POST /api/runs/cal-run-1/resume': {},
        ...detailRoutesFor(resumable)
      })
    })
    await dom.boot()
    dom.document.querySelector('[data-model="m2"]')!.click()
    await dom.settle()

    const resume = dom.document.querySelector('#modelDetailBody [data-action="resume"][data-run="cal-run-1"]')
    expect(resume, `${status} calibration must expose Resume`).not.toBeNull()
    const hashBefore = dom.window.location.hash
    resume!.click()
    await dom.settle()
    expect(dom.calls.some((call) => call.method === 'POST' && call.url === '/api/runs/cal-run-1/resume')).toBe(true)
    expect(dom.window.location.hash).toBe(hashBefore)
  })

  it('repaints the focused model card after Stop so the server-side paused state is visible', async () => {
    let runListCalls = 0
    const running = calRun({ status: 'running' })
    const paused = calRun({ status: 'paused' })
    dom = loadAppDom({
      routes: routes({
        'GET /api/runs': () => (++runListCalls === 1 ? [running] : [paused]),
        'POST /api/runs/cal-run-1/stop': {},
        ...detailRoutesFor(running)
      })
    })
    ;(dom.window as unknown as { confirm: () => boolean }).confirm = () => true
    await dom.boot()
    dom.document.querySelector('[data-model="m2"]')!.click()
    await dom.settle()

    dom.document.querySelector('#modelDetailBody [data-action="stop"][data-run="cal-run-1"]')!.click()
    await dom.settle()

    expect(dom.calls.some((call) => call.method === 'POST' && call.url === '/api/runs/cal-run-1/stop')).toBe(true)
    expect(dom.document.querySelector('#modelDetailBody [data-action="resume"][data-run="cal-run-1"]')).not.toBeNull()
    expect(dom.document.getElementById('modelDetailBody')!.textContent).toMatch(/szünet|folytatás/i)
  })
})

describe('loadInitialData invalidates stale live progress (issue #29 review)', () => {
  it('lets a fresh completed row win after reload instead of preserving the cached running status', async () => {
    let runListCalls = 0
    const running = calRun({ status: 'running' })
    const completed = calRun({ status: 'completed', done_cells: 8, response_count: 8 })
    dom = loadAppDom({
      routes: routes({
        'GET /api/runs': () => (++runListCalls === 1 ? [running] : [completed]),
        ...detailRoutesFor(running)
      })
    })
    await dom.boot()
    dom.document.querySelector('[data-model="m2"]')!.click()
    await dom.settle()

    const poll = (dom.window as unknown as { pollRunningProgress: () => Promise<void> }).pollRunningProgress
    await poll()
    await dom.settle()
    const loadInitialData = (dom.window as unknown as { loadInitialData: () => Promise<void> }).loadInitialData
    await loadInitialData()
    await dom.settle()

    expect(dom.document.querySelector('#modelDetailBody [data-action="record-profile"]')).not.toBeNull()
    expect(dom.document.getElementById('modelDetailBody')!.textContent).toMatch(/kész/i)
    expect(dom.document.querySelector('#modelDetailBody [data-cal-run="cal-run-1"] .badge-completed')).not.toBeNull()
    expect(dom.document.querySelector('#modelDetailBody [data-cal-run="cal-run-1"] .badge-running')).toBeNull()
  })
})

describe('a rejected on-card calibration launch refreshes the focused card (issue #29 review)', () => {
  it('renders the blocking run and disables the launch form after a real 409 response', async () => {
    const blocking = calRun({ id: 'blocking-calibration' })
    dom = loadAppDom({ routes: routes() })
    await dom.boot()
    dom.document.querySelector('[data-model="m2"]')!.click()
    await dom.settle()

    dom.document.querySelector('#modelDetailBody .model-card-probe-select')!.value = 'probe'
    const submit = dom.document.querySelector('#modelDetailBody button[type="submit"]')!
    submit.focus()
    const calls: { method: string; url: string }[] = []
    const browser = dom.window as unknown as {
      fetch: (url: string, init?: { method?: string }) => Promise<{ status: number; json: () => Promise<unknown> }>
    }
    browser.fetch = async (url, init = {}) => {
      const method = init.method ?? 'GET'
      calls.push({ method, url })
      if (method === 'POST' && url === '/api/models/m2/calibrate') {
        return { status: 409, json: async () => ({ success: false, error: 'Már van aktív kalibráció' }) }
      }
      if (method === 'GET' && url === '/api/runs') {
        return { status: 200, json: async () => ({ success: true, data: [blocking] }) }
      }
      throw new Error(`Unexpected request after launch: ${method} ${url}`)
    }

    submit.click()
    await dom.settle()

    expect(calls).toContainEqual({ method: 'POST', url: '/api/models/m2/calibrate' })
    expect(dom.lastAlert()).toMatch(/aktív kalibráció/i)
    expect(dom.document.querySelector('#modelDetailBody [data-cal-run="blocking-calibration"]')).not.toBeNull()
    expect(dom.document.querySelector('#modelDetailBody button[type="submit"]')!.disabled).toBe(true)
  })

  it('renders an exact-name malformed legacy blocker after the focused launch receives 409', async () => {
    const blocking = calRun({ id: 'malformed-blocker', config_json: '{broken' })
    dom = loadAppDom({ routes: routes() })
    await dom.boot()
    dom.document.querySelector('[data-model="m2"]')!.click()
    await dom.settle()

    dom.document.querySelector('#modelDetailBody .model-card-probe-select')!.value = 'probe'
    const submit = dom.document.querySelector('#modelDetailBody button[type="submit"]')!
    submit.focus()
    const browser = dom.window as unknown as {
      fetch: (url: string, init?: { method?: string }) => Promise<{ status: number; json: () => Promise<unknown> }>
    }
    browser.fetch = async (url, init = {}) => {
      const method = init.method ?? 'GET'
      if (method === 'POST' && url === '/api/models/m2/calibrate') {
        return { status: 409, json: async () => ({ success: false, error: 'Már van aktív kalibráció' }) }
      }
      if (method === 'GET' && url === '/api/runs') {
        return { status: 200, json: async () => ({ success: true, data: [blocking] }) }
      }
      throw new Error(`Unexpected request after launch: ${method} ${url}`)
    }

    submit.click()
    await dom.settle()

    expect(dom.lastAlert()).toMatch(/aktív kalibráció/i)
    expect(dom.document.querySelector('#modelDetailBody [data-cal-run="malformed-blocker"]')).not.toBeNull()
    expect(dom.document.querySelector('#modelDetailBody button[type="submit"]')!.disabled).toBe(true)
  })
})

describe('the model card uses the backend legacy-calibration boundary (issue #29 review)', () => {
  it('does not treat an exact-name ordinary run with calibration:false as a calibration', async () => {
    const ordinary = calRun({
      id: 'explicitly-ordinary',
      config_json: JSON.stringify({
        model: 'm2', temperature: 1, seeds: [0, 1], baselineArm: true, calibration: false
      })
    })
    dom = loadAppDom({
      routes: routes({ 'GET /api/runs': [ordinary], ...detailRoutesFor(ordinary) })
    })
    await dom.boot()
    dom.document.querySelector('[data-model="m2"]')!.click()
    await dom.settle()

    expect(dom.document.querySelector('#modelDetailBody [data-cal-run="explicitly-ordinary"]')).toBeNull()
    expect(dom.document.querySelector('#modelDetailBody button[type="submit"]')!.disabled).toBe(false)
  })
})

describe('finishing visibly transitions the card to "done — profile recordable" (issue #29)', () => {
  it('changes from "running" to an explicit done/record-profile state once the calibration finishes', async () => {
    let callCount = 0
    const runningRun = calRun({ status: 'running' })
    const completedRun = calRun({ status: 'completed' })
    dom = loadAppDom({
      routes: routes({
        'GET /api/runs': () => {
          callCount++
          return callCount === 1 ? [runningRun] : [completedRun]
        },
        ...detailRoutesFor(runningRun)
      })
    })
    await dom.boot()
    dom.document.querySelector('[data-model="m2"]')!.click()
    await dom.settle()

    // Before: no completed run yet, so no direct "record the profile" action.
    expect(dom.document.querySelector('#modelDetailBody [data-action="record-profile"]')).toBeNull()

    const refresh = (dom.window as unknown as { refreshRunsList: () => Promise<void> }).refreshRunsList
    await refresh()
    await dom.settle()

    // After: the same card must now visibly say it is done, with a direct action.
    const text = dom.document.getElementById('modelDetailBody')!.textContent!
    expect(text).toMatch(/kész/i)
    expect(dom.document.querySelector('#modelDetailBody [data-action="record-profile"]')).not.toBeNull()
  })
})
