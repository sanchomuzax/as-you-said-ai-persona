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

  it('opens a project and shows its personas and questionnaires', async () => {
    dom = loadAppDom({ routes: entityRoutes() })
    await dom.boot()
    ;(dom.document.querySelector('[data-entity="projects"]')!).click()
    await dom.settle()
    const body = dom.document.getElementById('entityDetailBody')!.textContent!
    expect(body).toContain('Anna')
    expect(body).toContain('Akciós tájékozódás')
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
})
