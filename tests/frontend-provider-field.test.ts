import { describe, it, expect, afterEach } from 'vitest'
import { loadAppDom, defaultRoutes, type AppDom } from './helpers/load-app-dom.js'

/**
 * Issue #28 end-to-end: the run/interview/calibration forms' "Szolgáltató
 * rögzítése" field is a dropdown now, sourced from GET /api/models/:model/providers
 * (real observed data + OpenRouter's live catalog), not a hand-typed slug.
 */

let dom: AppDom | null = null

afterEach(() => {
  dom?.close()
  dom = null
})

const TWO_MODELS = { default: 'm1', models: [{ id: 'm1', label: 'Modell 1' }, { id: 'm2', label: 'Modell 2' }] }

function providerRoutes(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return defaultRoutes({
    'GET /api/models': TWO_MODELS,
    'GET /api/models/m1/providers': {
      options: [{ value: 'deepinfra/fp4', providerName: 'DeepInfra', quantization: 'fp4', observedCount: 5, source: 'both' }],
      catalogAvailable: true,
      catalogError: false
    },
    'GET /api/models/m2/providers': {
      options: [{ value: 'Fireworks', providerName: 'Fireworks', quantization: null, observedCount: 2, source: 'observed' }],
      catalogAvailable: false,
      catalogError: false
    },
    ...overrides
  })
}

describe('run form provider select', () => {
  it('offers "Nem rögzítem" plus the current model’s real options after boot', async () => {
    dom = loadAppDom({ routes: providerRoutes() })
    await dom.boot()
    const select = dom.document.getElementById('runProvider')!
    expect(select.innerHTML).toContain('Nem rögzítem (bármelyik szolgáltató)')
    expect(select.innerHTML).toContain('deepinfra/fp4')
    expect(select.innerHTML).toContain('DeepInfra')
  })

  it('refreshes when a different model is chosen', async () => {
    dom = loadAppDom({ routes: providerRoutes() })
    await dom.boot()
    const modelSelect = dom.document.getElementById('runModel')!
    modelSelect.value = 'm2'
    modelSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    await dom.settle()
    const select = dom.document.getElementById('runProvider')!
    expect(select.innerHTML).toContain('Fireworks')
    expect(select.innerHTML).not.toContain('deepinfra/fp4')
  })

  const PROJECT = { id: 'p1', name: 'Projekt' }

  it('submits the exact pin value of the chosen option, not its display label', async () => {
    let posted: { url: string; body: unknown } | null = null
    dom = loadAppDom({
      routes: providerRoutes({
        'GET /api/projects': [PROJECT],
        'GET /api/personas': [{ id: 'per1', name: 'Persona' }],
        'GET /api/questionnaires': [{ id: 'q1', name: 'Q', questions: [] }],
        'POST /api/runs': (body: unknown, url: string) => {
          posted = { url, body }
          return { id: 'run-1' }
        }
      })
    })
    await dom.boot()
    const w = dom.window as unknown as { selectProjectEverywhere: (id: string) => void }
    w.selectProjectEverywhere('p1')
    await dom.settle()
    dom.document.getElementById('runName')!.value = 'Run'
    const providerSelect = dom.document.getElementById('runProvider')!
    providerSelect.value = 'deepinfra/fp4'
    dom.document
      .getElementById('runForm')!
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    await dom.settle()
    expect(posted).not.toBeNull()
    expect((posted as unknown as { body: { provider?: string } }).body.provider).toBe('deepinfra/fp4')
  })

  it('sends no provider when "Nem rögzítem" stays selected', async () => {
    let posted: { url: string; body: unknown } | null = null
    dom = loadAppDom({
      routes: providerRoutes({
        'GET /api/projects': [PROJECT],
        'GET /api/personas': [{ id: 'per1', name: 'Persona' }],
        'GET /api/questionnaires': [{ id: 'q1', name: 'Q', questions: [] }],
        'POST /api/runs': (body: unknown, url: string) => {
          posted = { url, body }
          return { id: 'run-1' }
        }
      })
    })
    await dom.boot()
    const w = dom.window as unknown as { selectProjectEverywhere: (id: string) => void }
    w.selectProjectEverywhere('p1')
    await dom.settle()
    dom.document.getElementById('runName')!.value = 'Run'
    dom.document
      .getElementById('runForm')!
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    await dom.settle()
    expect((posted as unknown as { body: { provider?: string } } | null)?.body.provider).toBeUndefined()
  })

  it('still renders (falling back to "Nem rögzítem" only) when the providers endpoint is unreachable', async () => {
    dom = loadAppDom({ routes: defaultRoutes({ 'GET /api/models': TWO_MODELS }) })
    await dom.boot()
    const select = dom.document.getElementById('runProvider')!
    expect(select.innerHTML).toContain('Nem rögzítem (bármelyik szolgáltató)')
  })
})

describe('interview form provider select', () => {
  it('offers the current model’s options after boot, and refreshes on model change', async () => {
    dom = loadAppDom({ routes: providerRoutes() })
    await dom.boot()
    const select = dom.document.getElementById('interviewProvider')!
    expect(select.innerHTML).toContain('deepinfra/fp4')

    const modelSelect = dom.document.getElementById('interviewModel')!
    modelSelect.value = 'm2'
    modelSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    await dom.settle()
    expect(select.innerHTML).toContain('Fireworks')
  })
})

describe('calibration form provider select (tab-level)', () => {
  it('offers the current model’s options and refreshes on model change', async () => {
    dom = loadAppDom({
      routes: providerRoutes({
        'GET /api/model-profiles': [
          { model: 'm1', label: 'Modell 1', status: 'missing', reasons: [], summary: null, profile: null },
          { model: 'm2', label: 'Modell 2', status: 'missing', reasons: [], summary: null, profile: null }
        ]
      })
    })
    await dom.boot()
    const select = dom.document.getElementById('calibrationProvider')!
    expect(select.innerHTML).toContain('deepinfra/fp4')

    const modelSelect = dom.document.getElementById('calibrationModel')!
    modelSelect.value = 'm2'
    modelSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    await dom.settle()
    expect(select.innerHTML).toContain('Fireworks')
  })
})

describe('on-card calibration launch provider select', () => {
  it("populates the model card's own provider select from the same endpoint", async () => {
    dom = loadAppDom({
      routes: providerRoutes({
        'GET /api/model-profiles': [
          { model: 'm1', label: 'Modell 1', status: 'missing', reasons: [], summary: null, profile: null }
        ],
        'GET /api/questionnaires': [{ id: 'probe', name: 'Próba-kérdőív', questions: [] }]
      })
    })
    await dom.boot()
    dom.document.querySelector('[data-model="m1"]')!.click()
    await dom.settle()
    const select = dom.document.querySelector('.model-card-provider-select')!
    expect(select.innerHTML).toContain('deepinfra/fp4')
  })
})
