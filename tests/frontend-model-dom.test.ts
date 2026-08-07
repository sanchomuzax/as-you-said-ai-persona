import { describe, it, expect, afterEach } from 'vitest'
import { loadPublicScript } from './helpers/load-public-script.js'
import { loadAppDom, defaultRoutes, type AppDom } from './helpers/load-app-dom.js'

/** "Modellek" tab: calibration status and the model card (M2). */

interface CardApi {
  renderModelList: (entries: Record<string, unknown>[]) => string
  renderModelCard: (entry: Record<string, unknown>, profile: Record<string, unknown> | null) => string
  calibrationStatusChip: (status: string) => string
}

const card = loadPublicScript<CardApi>(
  ['format.js', 'version-diff.js', 'metrics.js', 'detail.js', 'model-card.js'],
  '({ renderModelList, renderModelCard, calibrationStatusChip })'
)

const PROFILE = {
  id: 'prof-1',
  modelRequested: 'm1',
  modelVersion: 'm1-2026-05',
  provider: 'DeepInfra',
  promptTemplateHash: 'abc123def4567890',
  probeQuestionnaireId: 'probe',
  probeName: 'Alapértelmezett-perszóna próba',
  probeVersion: 1,
  language: 'hu',
  status: 'valid',
  reasons: [],
  createdAt: '2026-08-01 10:00:00',
  validUntil: '2026-10-30 10:00:00',
  metrics: {
    perQuestion: [
      {
        questionId: 'q1',
        text: 'Mennyire ért egyet?',
        options: ['Egyáltalán', 'Kicsit', 'Eléggé', 'Teljesen'],
        defaultDistribution: [0, 0, 0.2, 0.8],
        aggregatedResponseCount: 8,
        abstainCount: 0,
        invalidCount: 0
      }
    ],
    priorBias: { byPosition: [0.25, 0.25, 0.25, 0.25], maxDeviation: 0, strongestPosition: 0, optionCount: 4 },
    positivityOffset: 0.267,
    invalidRate: 0,
    abstainRate: 0,
    provenance: { runIds: ['cal'], cellCount: 8, costUsd: 0.008, firstResponseAt: null, lastResponseAt: null }
  }
}

describe('renderModelList', () => {
  it('shows a status chip per model and names the uncalibrated ones', () => {
    const html = card.renderModelList([
      { model: 'm1', label: 'Modell 1', status: 'valid', summary: { positivityOffset: 0.2, priorBiasMaxDeviation: 0.1, invalidRate: 0, cellCount: 8 } },
      { model: 'm2', label: 'Modell 2', status: 'missing', summary: null }
    ])
    expect(html).toContain('érvényes')
    expect(html).toContain('hiányzik')
    expect(html).toContain('Nincs mérés ehhez a modellhez.')
    expect(html).toContain('aria-label="Modell kalibrációjának megnyitása: Modell 1"')
  })

  // A negative offset means the model sits BELOW the scale midpoint; rendering it
  // without the sign would read as the opposite finding.
  it('renders a negative offset with its sign', () => {
    const html = card.renderModelList([
      { model: 'm1', label: 'M', status: 'valid', summary: { positivityOffset: -0.2, priorBiasMaxDeviation: 0, invalidRate: 0, cellCount: 1 } }
    ])
    expect(html).toContain('-0.200')
  })

  it('shows "—" for a metric that was not measured, never a zero', () => {
    const html = card.renderModelList([
      { model: 'm1', label: 'M', status: 'valid', summary: { positivityOffset: null, priorBiasMaxDeviation: null, invalidRate: null, cellCount: 0 } }
    ])
    expect(html).toContain('—')
  })

  it('handles an empty model list', () => {
    expect(card.renderModelList([])).toContain('Nincs beállított modell')
  })
})

describe('renderModelCard', () => {
  it('states that the profile is a reference point, not a correction', () => {
    const html = card.renderModelCard({ model: 'm1', label: 'M' }, PROFILE)
    expect(html).toMatch(/viszonyítási pont, nem korrekció/)
    expect(html).toMatch(/nyers válasznaplóhoz soha nem nyúlunk/)
  })

  it('shows the full measurement key', () => {
    const html = card.renderModelCard({ model: 'm1', label: 'M' }, PROFILE)
    expect(html).toContain('m1-2026-05')
    expect(html).toContain('DeepInfra')
    expect(html).toContain('abc123def4567890')
    expect(html).toContain('Alapértelmezett-perszóna próba (v1)')
  })

  it('renders the per-question default answer with its share', () => {
    const html = card.renderModelCard({ model: 'm1', label: 'M' }, PROFILE)
    expect(html).toContain('Mennyire ért egyet?')
    expect(html).toContain('Teljesen')
    expect(html).toContain('80%')
  })

  it('spells out why a stale profile is stale', () => {
    const html = card.renderModelCard(
      { model: 'm1', label: 'M' },
      { ...PROFILE, status: 'stale', reasons: ['A kiszolgáló szolgáltató megváltozott (DeepInfra → Fireworks).'] }
    )
    expect(html).toContain('A profil elavult.')
    expect(html).toContain('Fireworks')
    expect(html).toMatch(/a mostani beállításra nem érvényesek/)
  })

  // A missing profile is the most important finding on this screen: it means the
  // persona results from that model have nothing to be read against.
  it('explains what a missing profile costs the researcher', () => {
    const html = card.renderModelCard({ model: 'm1', label: 'M' }, null)
    expect(html).toMatch(/nincs mihez viszonyítani/)
  })

  // run-view.js already refuses to name a top answer that was never observed;
  // the model card must not be the one place that asserts one.
  it('does not name a default answer when nothing was measured', () => {
    const html = card.renderModelCard(
      { model: 'm1', label: 'M' },
      {
        ...PROFILE,
        metrics: {
          ...PROFILE.metrics,
          perQuestion: [
            { ...PROFILE.metrics.perQuestion[0]!, defaultDistribution: [0, 0, 0, 0], aggregatedResponseCount: 0 }
          ]
        }
      }
    )
    expect(html).toContain('nem mérhető')
    expect(html).not.toContain('Egyáltalán (0%')
  })

  it('says how many cells were skipped for a different elicitation mode', () => {
    const html = card.renderModelCard(
      { model: 'm1', label: 'M' },
      {
        ...PROFILE,
        metrics: {
          ...PROFILE.metrics,
          perQuestion: [{ ...PROFILE.metrics.perQuestion[0]!, legacyElicitationCount: 4 }]
        }
      }
    )
    expect(html).toContain('4 cella más elicitációs móddal készült, kihagyva')
  })

  // The bars used a class that does not exist in this stylesheet, so they
  // rendered at zero height — labels and percentages with nothing between them.
  it('draws the position bars inside a styled track', () => {
    const html = card.renderModelCard({ model: 'm1', label: 'M' }, PROFILE)
    expect(html).toContain('option-bar-track')
  })

  it('makes the status chip reachable and self-describing without a mouse', () => {
    const html = card.calibrationStatusChip('valid')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('role="note"')
    expect(html).toContain('aria-label="érvényes —')
  })

  it('escapes model- and questionnaire-supplied text', () => {
    const html = card.renderModelCard(
      { model: 'm1', label: 'M' },
      { ...PROFILE, probeName: '<img src=x onerror=alert(1)>' }
    )
    expect(html).not.toContain('<img')
  })
})

describe('calibrationStatusChip', () => {
  it('uses a distinct class per state', () => {
    expect(card.calibrationStatusChip('valid')).toContain('badge-completed')
    expect(card.calibrationStatusChip('stale')).toContain('badge-paused')
    expect(card.calibrationStatusChip('missing')).toContain('badge-pending')
  })
})

let dom: AppDom | null = null

afterEach(() => {
  dom?.close()
  dom = null
})

function modelRoutes(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return defaultRoutes({
    'GET /api/model-profiles': [
      {
        model: 'm1',
        label: 'Modell 1',
        status: 'valid',
        reasons: [],
        summary: { positivityOffset: 0.267, priorBiasMaxDeviation: 0, invalidRate: 0, abstainRate: 0, cellCount: 8, costUsd: 0.008 },
        profile: { id: 'prof-1', modelVersion: 'm1-2026-05', provider: 'DeepInfra', createdAt: '2026-08-01 10:00:00', validUntil: '2026-10-30 10:00:00', runIds: ['cal'] }
      },
      { model: 'm2', label: 'Modell 2', status: 'missing', reasons: [], summary: null, profile: null }
    ],
    'GET /api/model-profiles/prof-1': PROFILE,
    ...overrides
  })
}

describe('Modellek tab controller', () => {
  it('lists the calibration status of every configured model', async () => {
    dom = loadAppDom({ routes: modelRoutes() })
    await dom.boot()
    const list = dom.document.getElementById('modelsList')!.textContent!
    expect(list).toContain('Modell 1')
    expect(list).toContain('érvényes')
    expect(list).toContain('hiányzik')
  })

  it('opens the model card on click', async () => {
    dom = loadAppDom({ routes: modelRoutes() })
    await dom.boot()
    dom.document.querySelector('[data-model="m1"]')!.click()
    await dom.settle()
    expect(dom.document.getElementById('modelDetailView')!.style.display).toBe('block')
    expect(dom.document.getElementById('modelDetailBody')!.textContent).toContain('m1-2026-05')
  })

  it('shows the uncalibrated explanation without fetching a profile', async () => {
    dom = loadAppDom({ routes: modelRoutes() })
    await dom.boot()
    const before = dom.calls.length
    dom.document.querySelector('[data-model="m2"]')!.click()
    await dom.settle()
    expect(dom.document.getElementById('modelDetailBody')!.textContent).toMatch(/nincs mihez viszonyítani/)
    expect(dom.calls.slice(before).map((c) => c.url).join(' ')).not.toContain('/api/model-profiles/')
  })

  it('restores a model card from the URL hash', async () => {
    dom = loadAppDom({ routes: modelRoutes() })
    dom.window.location.hash = '#models/m1'
    await dom.boot()
    expect(dom.document.getElementById('modelDetailView')!.style.display).toBe('block')
    expect(dom.document.getElementById('modelDetailTitle')!.textContent).toBe('Modell 1')
  })

  it('offers every configured model and questionnaire for calibration', async () => {
    dom = loadAppDom({
      routes: modelRoutes({
        'GET /api/questionnaires': [{ id: 'probe', name: 'Próba-kérdőív', questions: [] }]
      })
    })
    await dom.boot()
    expect(dom.document.getElementById('calibrationModel')!.textContent).toContain('Modell 1')
    expect(dom.document.getElementById('calibrationQuestionnaire')!.textContent).toContain('Próba-kérdőív')
    expect(dom.document.getElementById('profileModel')!.textContent).toContain('Modell 2')
  })

  it('launches a calibration run for the selected model and probe', async () => {
    let posted: { url: string; body: unknown } | null = null
    dom = loadAppDom({
      routes: modelRoutes({
        'GET /api/questionnaires': [{ id: 'probe', name: 'Próba-kérdőív', questions: [] }],
        'POST /api/models/m1/calibrate': (body: unknown, url: string) => {
          posted = { url, body }
          return { runId: 'run-9' }
        }
      })
    })
    await dom.boot()
    ;(dom.document.getElementById('calibrationQuestionnaire')!).value = 'probe'
    dom.document.querySelector('#calibrationForm button[type="submit"]')!.click()
    await dom.settle()
    expect(posted).not.toBeNull()
    expect(posted!.body).toMatchObject({ questionnaireId: 'probe' })
  })

  it('does not launch a calibration without a probe questionnaire', async () => {
    dom = loadAppDom({ routes: modelRoutes() })
    await dom.boot()
    const before = dom.calls.length
    // Submitted directly: the `required` attribute already blocks the button in a
    // browser, so this exercises the handler's own guard rather than the markup's.
    dom.document
      .querySelector('#calibrationForm')!
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    await dom.settle()
    expect(dom.calls.slice(before).map((c) => c.url).join(' ')).not.toContain('/calibrate')
    expect(dom.lastAlert()).toMatch(/próba-kérdőívet/)
  })

  // Issue #24: closeModelDetail hard-codes the hash to 'models' and never
  // calls setActiveTab — harmless today only because the ONE existing entry
  // point (#modelsList) is itself reachable only while already on the models
  // tab. A hash deep link does NOT reproduce the bug: app.js's applyRoute
  // already sets state.activeTab and calls setActiveTab for its modelId
  // branch before opening the card. The vulnerable path is a DIRECT call to
  // openModelDetail from outside the models tab — what a future cross-tab
  // entry point would do (same shape as issue #23's run cards).
  describe('cross-tab entry keeps the hash and the visible tab in agreement (issue #24)', () => {
    it('agree after opening from a different tab and pressing Vissza', async () => {
      dom = loadAppDom({ routes: modelRoutes() })
      await dom.boot()
      dom.document.querySelector('[data-tab="runs"]')!.click()
      await dom.settle()
      expect(dom.window.location.hash).toBe('#runs')

      const w = dom.window as unknown as { openModelDetail: (id: string) => Promise<void> }
      await w.openModelDetail('m1')
      await dom.settle()

      dom.document.getElementById('modelDetailBackBtn')!.click()
      await dom.settle()

      const pane = dom.document.querySelector('.tab-pane.active')
      const activeTabName = (pane?.getAttribute('id') ?? '').replace(/^tab-/, '')
      expect(dom.window.location.hash).toBe('#' + activeTabName)
      expect(dom.document.querySelector(`[data-tab="${activeTabName}"]`)!.className).toContain('active')
    })
  })
})
