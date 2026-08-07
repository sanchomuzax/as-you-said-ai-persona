import { describe, it, expect, afterEach } from 'vitest'
import { loadPublicScript } from './helpers/load-public-script.js'
import { loadAppDom, defaultRoutes, type AppDom } from './helpers/load-app-dom.js'

/** Accessibility requirements from issue #12. */

interface DetailApi {
  entityListItem: (kind: string, id: string, title: string, meta?: string) => string
  renderProjectDetail: (project: Record<string, unknown>, context: Record<string, unknown>) => string
}

const detail = loadPublicScript<DetailApi>(
  ['format.js', 'version-diff.js', 'metrics.js', 'detail.js'],
  '({ entityListItem, renderProjectDetail })'
)

describe('clickable list rows', () => {
  it('name what opening them does, per entity kind', () => {
    expect(detail.entityListItem('personas', 'p1', 'Anna')).toContain('aria-label="Perszóna megnyitása: Anna"')
    expect(detail.entityListItem('projects', 'x', 'Startlap')).toContain('aria-label="Projekt megnyitása: Startlap"')
    expect(detail.entityListItem('questionnaires', 'q', 'AU v1')).toContain(
      'aria-label="Kérdőív megnyitása: AU v1"'
    )
  })

  it('escapes the label, which is an attribute context', () => {
    const html = detail.entityListItem('personas', 'p1', 'A "B"')
    expect(html).toContain('aria-label="Perszóna megnyitása: A &quot;B&quot;"')
  })

  it('labels the run rows inside a project detail', () => {
    const html = detail.renderProjectDetail(
      { id: 'p1', name: 'Startlap' },
      { personas: [], questionnaires: [], runs: [{ id: 'r1', name: 'Első futás', status: 'completed' }] }
    )
    expect(html).toContain('aria-label="Futtatás megnyitása: Első futás"')
  })
})

let dom: AppDom | null = null

afterEach(() => {
  dom?.close()
  dom = null
})

const PROJECT = { id: 'p1', name: 'Startlap' }
const PERSONA = {
  id: 'per1',
  projectId: 'p1',
  name: 'Anna',
  version: 1,
  isLatest: true,
  demographics: { kor: 34 },
  createdAt: '2026-08-06 10:00:00'
}

function routes(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return defaultRoutes({
    'GET /api/projects': [PROJECT],
    'GET /api/projects/p1': PROJECT,
    'GET /api/personas': [PERSONA],
    'GET /api/personas/per1': PERSONA,
    'GET /api/personas/per1/versions': [PERSONA],
    'GET /api/questionnaires': [],
    'GET /api/runs': [],
    ...overrides
  })
}

describe('focus handling', () => {
  it('returns focus to the row the detail was opened from', async () => {
    dom = loadAppDom({ routes: routes() })
    await dom.boot()
    const row = dom.document.querySelector('[data-entity="projects"]')!
    row.click()
    await dom.settle()
    // the detail heading takes focus while open
    expect(dom.document.activeElement).toBe(dom.document.getElementById('entityDetailTitle')!)
    ;(dom.document.getElementById('entityDetailBackBtn')!).click()
    await dom.settle()
    expect(dom.document.activeElement).toBe(row)
  })

  it('survives a row that no longer exists after closing', async () => {
    dom = loadAppDom({ routes: routes() })
    await dom.boot()
    ;(dom.document.querySelector('[data-entity="projects"]')!).click()
    await dom.settle()
    dom.document.getElementById('projectsList')!.innerHTML = ''
    ;(dom.document.getElementById('entityDetailBackBtn')!).click()
    await dom.settle()
    // no throw, and the view is closed
    expect(dom.document.getElementById('entityDetailView')!.style.display).toBe('none')
  })
})

describe('live region', () => {
  it('announces run progress politely', async () => {
    dom = loadAppDom({ routes: routes() })
    await dom.boot()
    const region = dom.document.getElementById('runStatusLive')!
    expect(region).not.toBeNull()
    expect(region.getAttribute('aria-live')).toBe('polite')
  })
})

describe('keyboard-reachable explanations', () => {
  const metrics = loadPublicScript<{ chip: (c: string, l: string, t?: string) => string }>(
    ['format.js', 'metrics.js'],
    '({ chip })'
  )

  // The metric explanations are the substance of the research UI (issue #2). A
  // hover-only tooltip is unreachable from a keyboard and on a touch screen.
  it('gives an explained chip focus and an accessible description', () => {
    const html = metrics.chip('metric-chip', 'PC 0.67', 'Pozíció-konzisztencia')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('role="note"')
    expect(html).toContain('aria-label="PC 0.67 — Pozíció-konzisztencia"')
    // the hover tooltip stays: it is the fastest path for a mouse user
    expect(html).toContain('title="Pozíció-konzisztencia"')
  })

  it('leaves an unexplained chip out of the tab order', () => {
    const html = metrics.chip('metric-chip', 'PC 0.67')
    expect(html).not.toContain('tabindex')
    expect(html).not.toContain('aria-label')
  })

  it('escapes the description in both attributes', () => {
    const html = metrics.chip('metric-chip', 'A"B', 'C"D')
    expect(html).not.toMatch(/aria-label="[^"]*"[A-Z]/)
    expect(html).toContain('&quot;')
  })
})
