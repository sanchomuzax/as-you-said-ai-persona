import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { loadAppDom, defaultRoutes, type AppDom } from './helpers/load-app-dom.js'
import { loadPublicScript } from './helpers/load-public-script.js'
import { ACTIVE_CALIBRATION_STATUSES as SERVER_ACTIVE_CALIBRATION_STATUSES } from '../src/model-profiles.js'

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
    'GET /api/questionnaires': [{ id: 'probe', name: 'Próba-kérdőív', questions: [] }],
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
    // card at all today. "órá" (not "óra"): Hungarian vowel harmony means
    // "óra" is not a substring of the natural inflected form "órája" — a
    // narrower regex here previously forced a correct "3 órája fut" to fail
    // and got "3 óra óta fut" shipped to satisfy it instead. The test was
    // wrong, not the language.
    expect(text).toMatch(/perc|órá|másodperc|ideje fut|eltelt/i)
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

    // Issue #29 review round 3, CRITICAL 1: a real browser has had the
    // periodic 5s poll (startProgressPolling) tick at least once by the time
    // a running calibration finishes — that tick writes
    // state.runProgress['cal-run-1'].status = 'running', which
    // calibrationRunsFor (model-view.js) then prefers over the row's own
    // status forever (`live.status || run.status`), since nothing ever
    // invalidates it and the poll's own filter (pollRunningProgress,
    // runs-list.js) stops re-visiting this run the moment its ROW status
    // stops being 'running' — exactly what is about to happen below. Without
    // this tick, the merge harmlessly falls through to the fresh row status
    // and the bug goes unexercised.
    const pollFn = (dom.window as unknown as { pollRunningProgress: () => Promise<void> }).pollRunningProgress
    await pollFn()
    await dom.settle()

    const refresh = (dom.window as unknown as { refreshRunsList: () => Promise<void> }).refreshRunsList
    await refresh()
    await dom.settle()

    // After: the same card must now visibly say it is done, with a direct action.
    const text = dom.document.getElementById('modelDetailBody')!.textContent!
    expect(text).toMatch(/kész/i)
    expect(dom.document.querySelector('#modelDetailBody [data-action="record-profile"]')).not.toBeNull()
  })
})

// Issue #29 reopened: a post-hoc code review found the functional half of the
// original fix never shipped, even though the v0.18.2 release notes claimed
// it did. The visible half (progress card, stop button, elapsed time) is
// real; the protection against a double launch is not.
describe('the launch form does not double-submit (issue #29 review CRITICAL #2)', () => {
  it('two rapid submits against a slow-latency stub result in exactly ONE calibrate request', async () => {
    let postCount = 0
    dom = loadAppDom({
      routes: routes({
        // The review's own reproduction: a 5ms-latency stub.
        'POST /api/models/m2/calibrate': async () => {
          postCount++
          await new Promise((resolve) => setTimeout(resolve, 5))
          return { runId: 'run-' + postCount }
        }
      })
    })
    await dom.boot()
    dom.document.querySelector('[data-model="m2"]')!.click()
    await dom.settle()
    dom.document.querySelector('.model-card-probe-select')!.value = 'probe'

    const form = dom.document.querySelector('.model-card-calibrate-form')!
    // Dispatched back to back, before either submit has a chance to resolve.
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    await dom.settle()

    expect(postCount).toBe(1)
  })
})

// Issue #29 review HIGH #3: rerenderModelDetailBody (public/model-view.js)
// skips its own repaint while focus is inside the card — and clicking Stop
// puts focus exactly there (a real click focuses the clicked element), so the
// post-stop repaint is silently swallowed and the card never self-heals.
describe('the card self-heals after Stop, even though focus stays inside it (issue #29 review HIGH #3)', () => {
  it('stops showing the running badge and the stop control once the run is stopped, with no click elsewhere', async () => {
    let runsCallCount = 0
    const running = calRun()
    const stopped = calRun({ status: 'stopped' })
    dom = loadAppDom({
      routes: routes({
        'GET /api/runs': () => {
          runsCallCount++
          return runsCallCount === 1 ? [running] : [stopped]
        },
        ...detailRoutesFor(running),
        'POST /api/runs/cal-run-1/stop': () => ({})
      })
    })
    // happy-dom has no confirm() of its own; the real app's stop action is
    // gated behind one (runs-list.js's handleRunAction).
    ;(dom.window as unknown as { confirm: () => boolean }).confirm = () => true

    await dom.boot()
    dom.document.querySelector('[data-model="m2"]')!.click()
    await dom.settle()

    // Issue #29 review round 3, CRITICAL 1: same reasoning as the "finishing"
    // test above — a real user's browser has had the periodic poll tick at
    // least once before they ever click Stop, caching runProgress['cal-run-1']
    // .status = 'running'. Without this tick the merge in calibrationRunsFor
    // falls through to the fresh row status and never exercises the cache.
    const pollFn = (dom.window as unknown as { pollRunningProgress: () => Promise<void> }).pollRunningProgress
    await pollFn()
    await dom.settle()

    const stopBtn = dom.document.querySelector('#modelDetailBody [data-action="stop"][data-run="cal-run-1"]')!
    // A real browser click also focuses the clicked element — the exact
    // condition the repaint's own-focus guard was written to protect against.
    stopBtn.focus()
    stopBtn.click()
    await dom.settle()

    expect(dom.document.querySelector('#modelDetailBody .badge-running'), 'running badge must be gone').toBeNull()
    expect(
      dom.document.querySelector('#modelDetailBody [data-action="stop"][data-run="cal-run-1"]'),
      'stop control must be gone'
    ).toBeNull()
  })
})

/**
 * Issue #29 review round 3, CRITICAL 1: the SSE 'status' event is the OTHER
 * path a real completion reaches the client through (app.js's
 * subscribeToEvents calls refreshRunsList() on every 'status' event, not
 * only the explicit-action path runs-list.js's handleRunAction uses). Once a
 * poll tick has cached 'running' into state.runProgress, an SSE-driven
 * refresh is exactly as stuck as the explicit-action one above — the bug
 * lives in the merge (calibrationRunsFor), not in which caller triggered the
 * repaint.
 */
describe('a completion delivered via the SSE "status" event still transitions the card, even after a cached poll (issue #29 review round 3, CRITICAL 1)', () => {
  it('shows done/record-profile once the run completes, after a prior poll tick cached "running"', async () => {
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

    const pollFn = (dom.window as unknown as { pollRunningProgress: () => Promise<void> }).pollRunningProgress
    await pollFn()
    await dom.settle()

    // The server pushing the run's completion, exactly as it would over the
    // real EventSource connection — not a direct call into a poll/refresh
    // function this time.
    dom.emitServerEvent('status', { runId: 'cal-run-1' })
    await dom.settle()

    const text = dom.document.getElementById('modelDetailBody')!.textContent!
    expect(text).toMatch(/kész/i)
    expect(dom.document.querySelector('#modelDetailBody [data-action="record-profile"]')).not.toBeNull()
  })
})

// Issue #29 review HIGH #4: model-card.js's launch-blocking filter checks
// `status === 'running'` only, while the SAME file's isActive concept (used
// for the progress card two lines above it) is `running || paused`. The
// server flips every 'running' run to 'paused' at boot (src/server.ts), so a
// plain service restart silently disarms the guard for any calibration that
// was mid-flight at the time.
describe('a PAUSED calibration also blocks re-launching, not just a running one (issue #29 review HIGH #4)', () => {
  it('disables the launch control when the model’s calibration is paused', async () => {
    const paused = calRun({ status: 'paused' })
    dom = loadAppDom({ routes: routes({ 'GET /api/runs': [paused], ...detailRoutesFor(paused) }) })
    await dom.boot()
    dom.document.querySelector('[data-model="m2"]')!.click()
    await dom.settle()

    const body = dom.document.getElementById('modelDetailBody')!
    // A soft `if (submitBtn) expect(...)` would silently vanish if the fix
    // instead stopped rendering the form entirely — assert it still exists.
    const submitBtn = dom.document.querySelector('#modelDetailBody .model-card-calibrate-form button[type="submit"]')
    expect(submitBtn, 'the launch button must still exist, disabled').not.toBeNull()
    expect(submitBtn!.disabled, 'launch button must be disabled while paused').toBe(true)
    expect(body.textContent).toMatch(/már fut kalibráció|előbb fejeződjön be|állítsd le|fut.*kalibráció.*ehhez/i)
  })
})

// Issue #29 review MED #5: formatElapsed (public/model-card.js) rounds
// instead of flooring — 90s reads as "2 perce" — and has no day unit, so a
// 10-day-old calibration reads as "240 óra óta fut".
describe('formatElapsed floors instead of rounding, and adds a day unit (issue #29 review MED #5)', () => {
  const { formatElapsed } = loadPublicScript<{ formatElapsed: (createdAt: string) => string | null }>(
    ['format.js', 'model-card.js'],
    '({ formatElapsed })'
  )

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('floors 90 elapsed seconds to "1 perce", not rounds up to "2 perce"', () => {
    vi.setSystemTime(new Date('2026-08-07T12:00:00Z'))
    const text = formatElapsed('2026-08-07 11:58:30') // 90s earlier
    expect(text).toContain('1 perce')
    expect(text).not.toContain('2 perce')
  })

  it('does not call 59.6 elapsed minutes "1 óra" — it is not an hour yet', () => {
    vi.setSystemTime(new Date('2026-08-07T12:00:00Z'))
    const text = formatElapsed('2026-08-07 11:00:24') // 59.6 minutes earlier
    expect(text).not.toMatch(/1\s*órá/i)
    expect(text).toContain('59 perce')
  })

  it('uses a day unit for a calibration running 10 days, instead of "240 óra"', () => {
    vi.setSystemTime(new Date('2026-08-17T12:00:00Z'))
    const text = formatElapsed('2026-08-07 12:00:00') // exactly 10 days earlier
    expect(text).not.toContain('240 óra')
    expect(text).toMatch(/10\s*nap/i)
  })
})

/**
 * Issue #29, second review round, HIGH 2: 'pending' is in the server guard's
 * blocking set, but nothing in the UI can clear it — runs-list.js's
 * runControlButtons and model-card.js's calibrationRunRow both gate the stop
 * control on running||paused, excluding 'pending'. The server DOES accept
 * POST /runs/:id/stop for a pending run, so the escape exists but is
 * invisible — and it is reachable: a throw inside executeLocked before its
 * first setStatus('running') leaves a launched run 'pending' forever,
 * silently (its own .catch(() => undefined) swallows exactly that).
 */
describe('a PENDING calibration is not a dead end (issue #29 review round 2, HIGH 2)', () => {
  it('offers a stop control for a pending calibration, on the model card', async () => {
    const pending = calRun({ status: 'pending' })
    dom = loadAppDom({ routes: routes({ 'GET /api/runs': [pending], ...detailRoutesFor(pending) }) })
    await dom.boot()
    dom.document.querySelector('[data-model="m2"]')!.click()
    await dom.settle()

    const stopBtn = dom.document.querySelector('#modelDetailBody [data-action="stop"][data-run="cal-run-1"]')
    expect(stopBtn, 'a stop control for the pending run').not.toBeNull()
  })

  it('stopping a pending calibration unblocks launching again', async () => {
    let runsCallCount = 0
    const pending = calRun({ status: 'pending' })
    const stopped = calRun({ status: 'stopped' })
    dom = loadAppDom({
      routes: routes({
        'GET /api/runs': () => {
          runsCallCount++
          return runsCallCount === 1 ? [pending] : [stopped]
        },
        ...detailRoutesFor(pending),
        'POST /api/runs/cal-run-1/stop': () => ({})
      })
    })
    ;(dom.window as unknown as { confirm: () => boolean }).confirm = () => true

    await dom.boot()
    dom.document.querySelector('[data-model="m2"]')!.click()
    await dom.settle()

    const stopBtn = dom.document.querySelector('#modelDetailBody [data-action="stop"][data-run="cal-run-1"]')
    expect(stopBtn, 'a stop control for the pending run must exist to click').not.toBeNull()
    stopBtn!.focus()
    stopBtn!.click()
    await dom.settle()

    const submitBtn = dom.document.querySelector('#modelDetailBody .model-card-calibrate-form button[type="submit"]')
    expect(submitBtn, 'the launch button must still exist').not.toBeNull()
    expect(submitBtn!.disabled, 'launching must be unblocked once the pending run is stopped').toBe(false)
  })
})

/**
 * Issue #29, second review round, HIGH 3: the 409 leaves the stale page
 * stale — public/model-view.js's on-card submit handler alerts on error but
 * never refreshes, so the SECOND tab (the exact scenario the guard exists
 * for) keeps showing an enabled form with no sign of the blocking run.
 */
describe('a 409 refreshes the card instead of leaving it stale (issue #29 review round 2, HIGH 3)', () => {
  it('shows the blocking calibration after a 409, not just an alert', async () => {
    let runsCallCount = 0
    const blocking = calRun({ id: 'blocker-1', status: 'running' })
    dom = loadAppDom({
      routes: routes({
        // Boot sees no runs at all — this tab has no idea another one exists yet.
        'GET /api/runs': () => {
          runsCallCount++
          return runsCallCount === 1 ? [] : [blocking]
        },
        'POST /api/models/m2/calibrate': () => {
          const err = new Error('Már fut kalibráció ehhez a modellhez: m2') as Error & { status?: number }
          throw Object.assign(err, { status: 409 })
        }
      })
    })
    await dom.boot()
    dom.document.querySelector('[data-model="m2"]')!.click()
    await dom.settle()
    dom.document.querySelector('.model-card-probe-select')!.value = 'probe'

    expect(dom.document.querySelector('#modelDetailBody [data-cal-run="blocker-1"]')).toBeNull()

    dom.document
      .querySelector('.model-card-calibrate-form')!
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    await dom.settle()

    // A stale card would show nothing but have alerted; the fix must re-fetch
    // and paint the run that is actually blocking it.
    expect(dom.document.querySelector('#modelDetailBody [data-cal-run="blocker-1"]'), 'the blocking run must now be visible').not.toBeNull()
  })
})

/**
 * Issue #29, second review round, MED: client and server disagree on what
 * "active" means, in two directions — (a) the client also matches a legacy
 * run by NAME (model-view.js's calibrationRunsFor), which the server never
 * does (it requires config.calibration === true), so a flagless legacy run
 * makes the BROWSER block a launch the server would actually allow; (b) the
 * client's blocking set was running||paused, missing the server's wider set
 * (pending, budget_exhausted, failed) — a mismatch in the other direction,
 * where the browser shows an enabled form the server will 409.
 */
describe('client and server agree on what counts as an active calibration (issue #29 review round 2, MED)', () => {
  it.each([...SERVER_ACTIVE_CALIBRATION_STATUSES])(
    'disables the launch control for a %s calibration, matching the server’s guard set',
    async (status) => {
      const active = calRun({ status })
      dom = loadAppDom({ routes: routes({ 'GET /api/runs': [active], ...detailRoutesFor(active) }) })
      await dom.boot()
      dom.document.querySelector('[data-model="m2"]')!.click()
      await dom.settle()

      const submitBtn = dom.document.querySelector('#modelDetailBody .model-card-calibrate-form button[type="submit"]')
      expect(submitBtn, `launch control must still exist while ${status}`).not.toBeNull()
      expect(submitBtn!.disabled, `launch control must be disabled while ${status}`).toBe(true)
    }
  )

  it('does NOT block launching when only a flagless, name-matched legacy run exists (the server would allow it)', async () => {
    const legacy = calRun({
      // No `calibration: true` marker — a pre-#22 legacy calibration run,
      // recognizable only by its human-facing name.
      config_json: JSON.stringify({ model: 'm2', temperature: 1, seeds: [0, 1], baselineArm: true }),
      status: 'running'
    })
    dom = loadAppDom({ routes: routes({ 'GET /api/runs': [legacy], ...detailRoutesFor(legacy) }) })
    await dom.boot()
    dom.document.querySelector('[data-model="m2"]')!.click()
    await dom.settle()

    const submitBtn = dom.document.querySelector('#modelDetailBody .model-card-calibrate-form button[type="submit"]')
    expect(submitBtn, 'launch control must still exist').not.toBeNull()
    expect(submitBtn!.disabled, 'the server would allow this launch — the client must not block it').toBe(false)
  })
})

/**
 * Issue #29 review round 3, HIGH 3: both docblocks (src/model-profiles.ts's
 * ACTIVE_CALIBRATION_STATUSES and public/model-card.js's copy of it) claim
 * "the frontend tests pin this list against the server's" — nothing did.
 * The it.each above now at least SOURCES its literal from the server's own
 * export (no more hand-maintained third copy there), but that only proves
 * the server's set matches itself; it says nothing about the client's
 * actual, independently hand-maintained copy. This test reads that copy out
 * of the real public/model-card.js file (via loadPublicScript) and compares
 * it directly against the server's export — the one assertion that would
 * actually catch the two drifting apart, the exact failure mode that caused
 * round 2's bug in the first place.
 */
describe('the client’s ACTIVE_CALIBRATION_STATUSES literally equals the server’s (issue #29 review round 3, HIGH 3)', () => {
  it('public/model-card.js’s copy matches src/model-profiles.ts’s export, value for value', () => {
    const { ACTIVE_CALIBRATION_STATUSES: clientSet } = loadPublicScript<{
      ACTIVE_CALIBRATION_STATUSES: Set<string>
    }>('model-card.js', '({ ACTIVE_CALIBRATION_STATUSES })')

    expect(new Set(clientSet)).toEqual(new Set(SERVER_ACTIVE_CALIBRATION_STATUSES))
  })
})

/**
 * Issue #29 review round 3, HIGH 4 (first half): runs-list.js's
 * runControlButtons widened Stop to 'pending' (round 2, HIGH 2) but not to
 * 'failed'/'budget_exhausted' — both of which ARE in the guard's blocking
 * set (ACTIVE_CALIBRATION_STATUSES) and so now block launching a new
 * calibration for the model, yet have no visible way out wherever this same
 * function is reused: the Futtatások list (runs-list.js's renderRunCard) and
 * the run detail view (run-view.js).
 */
describe('every blocking calibration status keeps a visible stop control outside the model card too (issue #29 review round 3, HIGH 4)', () => {
  it.each(['failed', 'budget_exhausted'])(
    'offers a stop control for a %s calibration in the Futtatások list',
    async (status) => {
      const blocked = calRun({ status })
      dom = loadAppDom({ routes: routes({ 'GET /api/runs': [blocked], ...detailRoutesFor(blocked) }) })
      await dom.boot()

      const stopBtn = dom.document.querySelector(
        '#runsList [data-run-card="cal-run-1"] [data-action="stop"][data-run="cal-run-1"]'
      )
      expect(stopBtn, `a stop control for the ${status} run in the Futtatások list`).not.toBeNull()
    }
  )

  it.each(['failed', 'budget_exhausted'])(
    'offers a stop control for a %s calibration in the run detail view',
    async (status) => {
      const blocked = calRun({ status })
      dom = loadAppDom({ routes: routes({ 'GET /api/runs': [blocked], ...detailRoutesFor(blocked) }) })
      await dom.boot()
      dom.document.querySelector('#runsList [data-run-card="cal-run-1"]')!.click()
      await dom.settle()

      const stopBtn = dom.document.querySelector('#runDetailControls [data-action="stop"][data-run="cal-run-1"]')
      expect(stopBtn, `a stop control for the ${status} run in the run detail view`).not.toBeNull()
    }
  )
})

/**
 * Issue #29 review round 3, HIGH 4 (second half): the model card's
 * calibrationRunRow (public/model-card.js) renders a stop control for every
 * active status, but NEVER a resume ("Folytatás") one — unlike
 * runs-list.js's runControlButtons, which already offers Folytatás for
 * paused/budget_exhausted/failed. For a calibration 90% through that hit the
 * budget hard stop, the only card-visible escape is to throw the whole run
 * away; resuming it is only reachable by leaving the card for the
 * Futtatások list. On a token-budget research tool, that is the expensive
 * wrong default.
 */
describe('a resumable calibration also offers a way to resume, not only stop — on the model card too (issue #29 review round 3, HIGH 4)', () => {
  it.each(['paused', 'budget_exhausted', 'failed', 'pending'])(
    'offers a resume control for a %s calibration on the model card, not only stop',
    async (status) => {
      const blocked = calRun({ status })
      dom = loadAppDom({ routes: routes({ 'GET /api/runs': [blocked], ...detailRoutesFor(blocked) }) })
      await dom.boot()
      dom.document.querySelector('[data-model="m2"]')!.click()
      await dom.settle()

      const resumeBtn = dom.document.querySelector('#modelDetailBody [data-action="resume"][data-run="cal-run-1"]')
      expect(resumeBtn, `a resume control for the ${status} calibration on the model card`).not.toBeNull()
    }
  )
})

/**
 * Issue #29 review round 3, MED (1st): round 2's HIGH 3 fix
 * (handleCalibrationLaunchError, model-view.js) refreshes the page after a
 * 409 — but only for the calibrate launch. Resume goes through
 * runs-list.js's handleRunAction, whose catch block is still a bare
 * alert() with no refresh, so the SECOND tab (the exact scenario the guard
 * exists for) stays stale after a blocked resume, same as calibrate did
 * before round 2.
 */
describe('a 409 on resume refreshes the stale page too, not only calibrate’s 409 (issue #29 review round 3, MED)', () => {
  it('re-fetches the runs list after a 409 on resume, revealing the run actually blocking it', async () => {
    let runsCallCount = 0
    const resumable = calRun({ status: 'paused' })
    const blocking = calRun({ id: 'blocker-1', status: 'running' })
    dom = loadAppDom({
      routes: routes({
        // Boot sees only the resumable run — this tab has no idea a second,
        // blocking calibration for the same model exists yet.
        'GET /api/runs': () => {
          runsCallCount++
          return runsCallCount === 1 ? [resumable] : [resumable, blocking]
        },
        ...detailRoutesFor(resumable),
        'POST /api/runs/cal-run-1/resume': () => {
          const err = new Error('Már fut kalibráció ehhez a modellhez: m2') as Error & { status?: number }
          throw Object.assign(err, { status: 409 })
        }
      })
    })
    await dom.boot()

    const before = runsCallCount
    const resumeBtn = dom.document.querySelector(
      '#runsList [data-run-card="cal-run-1"] [data-action="resume"][data-run="cal-run-1"]'
    )
    expect(resumeBtn, 'a resume control for the paused run').not.toBeNull()
    resumeBtn!.click()
    await dom.settle()

    expect(
      runsCallCount,
      'a 409 on resume must refetch the runs list, exactly like calibrate’s 409 already does'
    ).toBeGreaterThan(before)
  })
})

/**
 * Issue #29 review round 3, MED (2nd): the block notice's tail
 * ("előbb fejeződjön be, vagy állítsd le lent…") is fixed text regardless of
 * the blocker's actual status — CALIBRATION_BLOCK_STATUS_TEXT already picks
 * the right VERB ("hibára futott" for failed), but the ADVICE after it still
 * claims the run might finish on its own, which is false for anything that
 * is not actually 'running'.
 */
describe('the block notice’s advice matches the actual blocking status, not just its label (issue #29 review round 3, MED)', () => {
  it('does not tell the researcher to wait for it to finish when the blocker has already failed', async () => {
    const failed = calRun({ status: 'failed' })
    dom = loadAppDom({ routes: routes({ 'GET /api/runs': [failed], ...detailRoutesFor(failed) }) })
    await dom.boot()
    dom.document.querySelector('[data-model="m2"]')!.click()
    await dom.settle()

    const body = dom.document.getElementById('modelDetailBody')!
    expect(body.textContent, 'a failed run is not going to progress toward finishing on its own').not.toMatch(
      /előbb fejeződjön be/i
    )
  })
})
