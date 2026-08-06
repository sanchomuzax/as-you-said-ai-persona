import { describe, it, expect } from 'vitest'
import { loadPublicScript } from './helpers/load-public-script.js'

const { renderProjectDetail, renderPersonaDetail, renderQuestionnaireDetail } = loadPublicScript<{
  renderProjectDetail: (p: Record<string, unknown>, ctx: Record<string, unknown[]>) => string
  renderPersonaDetail: (p: Record<string, unknown>, project?: Record<string, unknown> | null) => string
  renderQuestionnaireDetail: (q: Record<string, unknown>, project?: Record<string, unknown> | null) => string
}>(['format.js', 'metrics.js', 'detail.js'], '{ renderProjectDetail, renderPersonaDetail, renderQuestionnaireDetail }')

describe('renderPersonaDetail (Persona Provenance Card)', () => {
  const persona = {
    id: 'p1',
    name: 'Anna',
    demographics: { kor: '34', nem: 'nő' },
    biography: 'Budapesti tanár.',
    renderingStyle: 'bulleted_profile',
    provenance: { forrás: 'KSH Mikrocenzus 2022', arány: '12%' },
    createdAt: '2026-08-06 10:00:00'
  }

  it('shows the full demographics, biography and provenance', () => {
    const html = renderPersonaDetail(persona, { id: 'x', name: 'Projekt A' })
    expect(html).toContain('Anna')
    expect(html).toContain('kor')
    expect(html).toContain('34')
    expect(html).toContain('Budapesti tanár.')
    expect(html).toContain('KSH Mikrocenzus 2022')
    expect(html).toContain('Projekt A')
  })

  it('names the missing provenance instead of hiding it', () => {
    const html = renderPersonaDetail({ ...persona, provenance: null })
    expect(html).toContain('Nincs rögzített forrás')
    expect(html).toContain('detail-note-warning')
  })

  it('treats an empty provenance object as undocumented, not as documented', () => {
    const html = renderPersonaDetail({ ...persona, provenance: {} })
    expect(html).toContain('detail-note-warning')
  })

  it('says so when there is no biography', () => {
    const html = renderPersonaDetail({ ...persona, biography: null })
    expect(html).toContain('Nincs életrajz')
  })

  it('escapes persona text', () => {
    const html = renderPersonaDetail({ ...persona, name: '<img src=x onerror=alert(1)>' })
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })
})

describe('renderQuestionnaireDetail', () => {
  const questionnaire = {
    id: 'q1',
    name: 'Bizalom-kérdőív',
    questions: [
      { id: 'qq1', text: 'Bízol a bankokban?', options: ['Igen', 'Nem'] },
      { id: 'qq2', text: 'Miért?', options: ['a', 'b', 'c'] }
    ]
  }

  it('lists every question with its options', () => {
    const html = renderQuestionnaireDetail(questionnaire, { id: 'x', name: 'Projekt A' })
    expect(html).toContain('Bízol a bankokban?')
    expect(html).toContain('Igen')
    expect(html).toContain('Nem')
    expect(html).toContain('Miért?')
    expect(html).toContain('2 kérdés')
  })

  it('handles a questionnaire without questions', () => {
    expect(renderQuestionnaireDetail({ id: 'q', name: 'Üres', questions: [] })).toContain('Nincs kérdés')
  })

  it('escapes question and option text', () => {
    const html = renderQuestionnaireDetail({
      id: 'q',
      name: 'X',
      questions: [{ id: '1', text: '<script>a</script>', options: ['<b>o</b>', 'x'] }]
    })
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<b>o</b>')
  })
})

describe('renderProjectDetail', () => {
  const project = {
    id: 'pr1',
    name: 'Startlap',
    applicationDomain: 'média',
    targetPopulation: 'HU internetezők',
    createdAt: '2026-08-06 10:00:00'
  }

  it('shows the project meta and its personas, questionnaires and runs', () => {
    const html = renderProjectDetail(project, {
      personas: [{ id: 'p1', name: 'Anna', demographics: { kor: '34' } }],
      questionnaires: [{ id: 'q1', name: 'Bizalom', questions: [{ id: 'x', text: 't', options: ['a', 'b'] }] }],
      runs: [{ id: 'r1', name: 'Első futás', status: 'completed' }]
    })
    expect(html).toContain('Startlap')
    expect(html).toContain('média')
    expect(html).toContain('HU internetezők')
    expect(html).toContain('Anna')
    expect(html).toContain('Bizalom')
    expect(html).toContain('Első futás')
    expect(html).toContain('Kész')
  })

  it('shows empty states for a project without content', () => {
    const html = renderProjectDetail(project, { personas: [], questionnaires: [], runs: [] })
    expect(html).toContain('Nincs perszóna')
    expect(html).toContain('Nincs kérdőív')
    expect(html).toContain('Nincs futtatás')
  })

  it('makes the child items navigable by id', () => {
    const html = renderProjectDetail(project, {
      personas: [{ id: 'p1', name: 'Anna', demographics: {} }],
      questionnaires: [],
      runs: [{ id: 'r1', name: 'R', status: 'running' }]
    })
    expect(html).toContain('data-entity="personas"')
    expect(html).toContain('data-entity-id="p1"')
    expect(html).toContain('data-run="r1"')
  })
})
