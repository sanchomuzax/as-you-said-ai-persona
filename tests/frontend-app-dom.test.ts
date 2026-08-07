import { describe, it, expect, afterEach } from 'vitest'
import { loadAppDom, defaultRoutes, type AppDom } from './helpers/load-app-dom.js'

/**
 * View-controller tests (issue #10). These load the real page and the real
 * scripts, so they catch what the pure-helper tests structurally cannot: a
 * function that is never called, an element id that does not exist, a value that
 * reaches the renderer in the wrong shape.
 */

let dom: AppDom | null = null

afterEach(() => {
  dom?.close()
  dom = null
})

const PROJECT = { id: 'p1', name: 'Startlap', applicationDomain: 'Hírportál', targetPopulation: '18-65' }
const PERSONA = { id: 'per1', name: 'Anna', demographics: { kor: 34 }, version: 1, isLatest: true }

describe('boot', () => {
  it('shows the app and hides the login screen for an authenticated session', async () => {
    dom = loadAppDom({ routes: defaultRoutes() })
    await dom.boot()
    expect(dom.document.getElementById('appContainer')!.style.display).toBe('flex')
    expect(dom.document.getElementById('loginScreen')!.style.display).toBe('none')
  })

  it('stays on the login screen without a session', async () => {
    dom = loadAppDom({ routes: defaultRoutes({ 'GET /api/session': { authenticated: false } }) })
    await dom.boot()
    expect(dom.document.getElementById('loginScreen')!.style.display).toBe('flex')
  })

  it('renders the project list from the API', async () => {
    dom = loadAppDom({ routes: defaultRoutes({ 'GET /api/projects': [PROJECT] }) })
    await dom.boot()
    expect(dom.document.getElementById('projectsList')!.textContent).toContain('Startlap')
  })

  it('fills every project dropdown, including the interview filter', async () => {
    dom = loadAppDom({ routes: defaultRoutes({ 'GET /api/projects': [PROJECT] }) })
    await dom.boot()
    for (const id of [
      'personaProjectSelect',
      'runProjectSelect',
      'questionnaireProjectSelect',
      'interviewProjectSelect'
    ]) {
      expect(dom.document.getElementById(id)!.textContent, id).toContain('Startlap')
    }
  })

  it('offers the configured models in both the run and the interview form', async () => {
    dom = loadAppDom({ routes: defaultRoutes() })
    await dom.boot()
    expect(dom.document.getElementById('runModel')!.textContent).toContain('Modell 1')
    expect(dom.document.getElementById('interviewModel')!.textContent).toContain('Modell 1')
  })

  it('boots without an unhandled error even when an endpoint fails', async () => {
    dom = loadAppDom({ routes: defaultRoutes({ 'GET /api/runs': undefined }) })
    await dom.boot()
    // the failure is reported, not swallowed, and the app still comes up
    expect(dom.lastAlert()).toMatch(/Adatbetöltés sikertelen/)
  })
})

describe('tab navigation', () => {
  it('activates the interviews tab and its pane', async () => {
    dom = loadAppDom({ routes: defaultRoutes() })
    await dom.boot()
    const button = dom.document.querySelector('[data-tab="interviews"]')!
    button.click()
    await dom.settle()
    expect(dom.document.getElementById('tab-interviews')!.className).toContain('active')
    expect(dom.window.location.hash).toBe('#interviews')
  })
})

describe('interview view controller', () => {
  const INTERVIEW = {
    id: 'i1',
    title: 'Feltáró beszélgetés',
    personaId: 'per1',
    personaName: 'Anna',
    personaVersion: 1,
    model: 'm1',
    temperature: 0.8,
    seed: 0,
    turnCount: 2,
    createdAt: '2026-08-06 10:00:00'
  }
  const MESSAGES = [
    { id: 'm1', turn: 1, role: 'researcher', content: 'Hogyan tájékozódsz?', abstained: 0 },
    {
      id: 'm2',
      turn: 2,
      role: 'persona',
      content: 'Az akciós újságokból.',
      abstained: 0,
      model_version: 'm1-2026-05',
      provider: 'DeepInfra',
      temperature: 0.8,
      seed: 0,
      prompt_tokens: 40,
      completion_tokens: 12,
      cost_usd: 0.002,
      latency_ms: 123
    }
  ]

  function interviewRoutes(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return defaultRoutes({
      'GET /api/projects': [PROJECT],
      'GET /api/personas': [PERSONA],
      'GET /api/interviews': [INTERVIEW],
      'GET /api/interviews/i1': {
        interview: INTERVIEW,
        messages: MESSAGES,
        usage: { totalTokens: 52, costUsd: 0.002 }
      },
      ...overrides
    })
  }

  it('shows the methodological warning in the list and in the transcript', async () => {
    dom = loadAppDom({ routes: interviewRoutes() })
    await dom.boot()
    expect(dom.document.getElementById('interviewDisclaimer')!.textContent).toMatch(/nem mérés/)
    expect(dom.document.getElementById('interviewDetailDisclaimer')!.textContent).toMatch(/hipotézis/)
  })

  it('lists the interviews of the selected project', async () => {
    dom = loadAppDom({ routes: interviewRoutes() })
    await dom.boot()
    expect(dom.document.getElementById('interviewsList')!.textContent).toContain('Feltáró beszélgetés')
  })

  it('opens a transcript on click and renders both speakers', async () => {
    dom = loadAppDom({ routes: interviewRoutes() })
    await dom.boot()
    ;(dom.document.querySelector('[data-interview-id="i1"]')!).click()
    await dom.settle()

    expect(dom.document.getElementById('interviewDetailView')!.style.display).toBe('block')
    expect(dom.document.getElementById('interviewDetailTitle')!.textContent).toBe('Feltáró beszélgetés')
    const turns = dom.document.querySelectorAll('.interview-turn')
    expect(turns).toHaveLength(2)
    expect(dom.document.getElementById('interviewTranscript')!.textContent).toContain('Az akciós újságokból.')
    expect(dom.document.getElementById('interviewExportLink')!.getAttribute('href')).toBe(
      '/api/interviews/i1/export.csv'
    )
  })

  it('opens a transcript from the keyboard as well', async () => {
    dom = loadAppDom({ routes: interviewRoutes() })
    await dom.boot()
    const row = dom.document.querySelector('[data-interview-id="i1"]')!
    row.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await dom.settle()
    expect(dom.document.getElementById('interviewDetailView')!.style.display).toBe('block')
  })

  it('sends a question and renders the returned turns', async () => {
    let asked: unknown = null
    dom = loadAppDom({
      routes: interviewRoutes({
        'POST /api/interviews/i1/messages': (body: unknown) => {
          asked = body
          return {
            messages: [
              ...MESSAGES,
              { id: 'm3', turn: 3, role: 'researcher', content: 'És mennyire bízol bennük?', abstained: 0 },
              { id: 'm4', turn: 4, role: 'persona', content: 'Eléggé.', abstained: 0, seed: 0 }
            ],
            usage: { totalTokens: 90, costUsd: 0.003 }
          }
        }
      })
    })
    await dom.boot()
    ;(dom.document.querySelector('[data-interview-id="i1"]')!).click()
    await dom.settle()
    ;(dom.document.getElementById('interviewQuestion')!).value =
      'És mennyire bízol bennük?'
    ;(dom.document.getElementById('interviewSendBtn')!).click()
    await dom.settle()

    expect(asked).toEqual({ content: 'És mennyire bízol bennük?' })
    expect(dom.document.querySelectorAll('.interview-turn')).toHaveLength(4)
    // the composer is emptied and unlocked again, so the next question can be typed
    expect((dom.document.getElementById('interviewQuestion')!).value).toBe('')
    expect((dom.document.getElementById('interviewSendBtn')!).disabled).toBe(false)
  })

  it('reports a refused turn instead of silently doing nothing', async () => {
    dom = loadAppDom({ routes: interviewRoutes() })
    await dom.boot()
    ;(dom.document.querySelector('[data-interview-id="i1"]')!).click()
    await dom.settle()
    ;(dom.document.getElementById('interviewQuestion')!).value = 'Kérdés?'
    ;(dom.document.getElementById('interviewSendBtn')!).click()
    await dom.settle()
    // no stub for the POST route: the error must reach the researcher
    expect(dom.document.getElementById('interviewError')!.textContent).toMatch(/nem sikerült/)
    expect((dom.document.getElementById('interviewSendBtn')!).disabled).toBe(false)
  })

  it('does not send an empty question', async () => {
    dom = loadAppDom({ routes: interviewRoutes() })
    await dom.boot()
    ;(dom.document.querySelector('[data-interview-id="i1"]')!).click()
    await dom.settle()
    const before = dom.calls.length
    ;(dom.document.getElementById('interviewQuestion')!).value = '   '
    ;(dom.document.getElementById('interviewSendBtn')!).click()
    await dom.settle()
    expect(dom.calls.length).toBe(before)
  })

  it('restores an open transcript from the URL hash', async () => {
    dom = loadAppDom({ routes: interviewRoutes() })
    dom.window.location.hash = '#interviews/i1'
    await dom.boot()
    expect(dom.document.getElementById('interviewDetailView')!.style.display).toBe('block')
    expect(dom.document.getElementById('interviewDetailTitle')!.textContent).toBe('Feltáró beszélgetés')
  })

  // Code review finding: without a staleness guard a slow first request paints
  // its transcript under the second interview's header — the researcher then
  // reads persona A's answers as persona B's.
  it('does not paint a slower earlier interview over the one now open', async () => {
    const OTHER = { ...INTERVIEW, id: 'i2', title: 'Másik beszélgetés', personaName: 'Béla' }
    let releaseFirst: (() => void) | null = null
    dom = loadAppDom({
      routes: interviewRoutes({
        'GET /api/interviews': [INTERVIEW, OTHER],
        'GET /api/interviews/i1': () =>
          new Promise((resolve) => {
            releaseFirst = () =>
              resolve({ interview: INTERVIEW, messages: MESSAGES, usage: { totalTokens: 52, costUsd: 0.002 } })
          }),
        'GET /api/interviews/i2': {
          interview: OTHER,
          messages: [{ id: 'x1', turn: 1, role: 'researcher', content: 'Másik kérdés', abstained: 0 }],
          usage: { totalTokens: 10, costUsd: 0.001 }
        }
      })
    })
    await dom.boot()
    dom.document.querySelector('[data-interview-id="i1"]')!.click()
    await dom.settle()
    dom.document.querySelector('[data-interview-id="i2"]')!.click()
    await dom.settle()
    releaseFirst!()
    await dom.settle()

    expect(dom.document.getElementById('interviewDetailTitle')!.textContent).toBe('Másik beszélgetés')
    expect(dom.document.getElementById('interviewTranscript')!.textContent).toContain('Másik kérdés')
    expect(dom.document.getElementById('interviewTranscript')!.textContent).not.toContain(
      'Az akciós újságokból.'
    )
  })

  it('refreshes the list on close, so the exchange count is not stale', async () => {
    dom = loadAppDom({ routes: interviewRoutes() })
    await dom.boot()
    dom.document.querySelector('[data-interview-id="i1"]')!.click()
    await dom.settle()
    const before = dom.calls.filter((c) => c.url.startsWith('/api/interviews?') || c.url === '/api/interviews').length
    dom.document.getElementById('interviewDetailBackBtn')!.click()
    await dom.settle()
    const after = dom.calls.filter((c) => c.url.startsWith('/api/interviews?') || c.url === '/api/interviews').length
    expect(after).toBeGreaterThan(before)
  })

  it('opens the provenance of a persona turn', async () => {
    dom = loadAppDom({
      routes: interviewRoutes({
        'GET /api/interviews/i1/messages/m2': {
          id: 'm2',
          role: 'persona',
          content: 'Az akciós újságokból.',
          raw_response: 'Az akciós újságokból.',
          prompt_rendered: JSON.stringify([{ role: 'system', content: 'Profil...' }]),
          model_version: 'm1-2026-05',
          provider: 'DeepInfra',
          seed: 0,
          temperature: 0.8
        }
      })
    })
    await dom.boot()
    dom.document.querySelector('[data-interview-id="i1"]')!.click()
    await dom.settle()
    dom.document.querySelector('[data-interview-message="m2"]')!.click()
    await dom.settle()
    const panel = dom.document.getElementById('provenancePanel')!
    expect(panel.style.display).not.toBe('none')
    expect(dom.document.getElementById('provenanceBody')!.textContent).toContain('Profil...')
  })

  it('returns to the list on Vissza', async () => {
    dom = loadAppDom({ routes: interviewRoutes() })
    await dom.boot()
    ;(dom.document.querySelector('[data-interview-id="i1"]')!).click()
    await dom.settle()
    ;(dom.document.getElementById('interviewDetailBackBtn')!).click()
    await dom.settle()
    expect(dom.document.getElementById('interviewDetailView')!.style.display).toBe('none')
    expect((dom.document.querySelector('.tab-content')!).style.display).toBe('block')
  })
})
