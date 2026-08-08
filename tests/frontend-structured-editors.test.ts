import { describe, it, expect, afterEach } from 'vitest'
import { loadPublicScript } from './helpers/load-public-script.js'
import { loadAppDom, defaultRoutes, type AppDom } from './helpers/load-app-dom.js'

/**
 * Issue #37: the demographics/provenance/questionnaire fields used to expect a
 * hand-typed "kulcs: érték" / "Kérdés? [type]\n- opt" mini-syntax, documented
 * only in a placeholder that disappears the moment the user starts typing —
 * same defect class #28 fixed for the provider field. Key and value (question
 * and option) now get their own inputs; a hidden textarea still mirrors them
 * as text so parseDemographics/parseQuestions (public/parsers.js, untouched)
 * keep governing what actually gets saved.
 */

// ----- Pure builders (detail.js) — same load list as frontend-detail.test.ts,
// so a stray dependency on a script that test does NOT load would show up here. -----

const { kvEditorHtml, kvPairsFromObject, questionEditorHtml } = loadPublicScript<{
  kvEditorHtml: (fieldId: string, pairs: [string, string][], hint: string) => string
  kvPairsFromObject: (obj: Record<string, unknown> | null | undefined) => [string, string][]
  questionEditorHtml: (
    fieldId: string,
    questions: { text: string; options: string[]; scaleType?: string; scaleDirection?: string }[],
    hint: string
  ) => string
}>(['format.js', 'metrics.js', 'version-diff.js', 'detail.js'], '{ kvEditorHtml, kvPairsFromObject, questionEditorHtml }')

const COLON_VALUE = 'széleskörű: külföldi hírek (91%), belföldi (89%)'

describe('kvPairsFromObject', () => {
  it('stringifies non-string values (a persona demographic can be a number)', () => {
    expect(kvPairsFromObject({ kor: 34, nem: 'nő' })).toEqual([
      ['kor', '34'],
      ['nem', 'nő']
    ])
  })

  it('handles null/undefined as no pairs', () => {
    expect(kvPairsFromObject(null)).toEqual([])
    expect(kvPairsFromObject(undefined)).toEqual([])
  })
})

describe('kvEditorHtml', () => {
  it('renders one input pair per entry, not a single free-text blob', () => {
    const html = kvEditorHtml('demo', [['kor', '34'], ['nem', 'nő']], 'hint szöveg')
    expect(html).toContain('data-kv-key')
    expect(html).toContain('data-kv-value')
    expect((html.match(/data-kv-row=/g) || []).length).toBe(2)
    expect(html).toContain('value="kor"')
    expect(html).toContain('value="34"')
  })

  it('keeps a colon-laden value intact in both the visible input and the hidden sync textarea', () => {
    const html = kvEditorHtml('demo', [['hírérdeklődés', COLON_VALUE]], 'hint')
    expect(html).toContain(`value="${COLON_VALUE}"`)
    expect(html).toContain(`hírérdeklődés: ${COLON_VALUE}`)
  })

  it('shows the format hint as always-visible text, not as a vanishing placeholder', () => {
    const html = kvEditorHtml('demo', [], 'Ez egy mindig látható súgó.')
    expect(html).toContain('Ez egy mindig látható súgó.')
    expect(html).toMatch(/<p class="form-note">Ez egy mindig látható súgó\.<\/p>/)
  })

  it('shows immediate feedback on how the (initial) input is interpreted', () => {
    const html = kvEditorHtml('demo', [['kor', '34']], 'hint')
    expect(html).toContain('data-kv-feedback')
    expect(html).toContain('kor')
  })
})

describe('questionEditorHtml', () => {
  it('renders a question-text input and one input per option, not a single free-text blob', () => {
    const html = questionEditorHtml('q', [{ text: 'Kérdés?', options: ['A', 'B'] }], 'hint')
    expect(html).toContain('data-q-text')
    expect(html).toContain('data-q-option-text')
    expect((html.match(/data-q-option=/g) || []).length).toBe(2)
    expect(html).toContain('value="Kérdés?"')
  })

  it('round-trips the scale marker into the hidden sync textarea', () => {
    const html = questionEditorHtml(
      'q',
      [{ text: 'Kérdés?', options: ['A', 'B'], scaleType: 'multi_choice', scaleDirection: 'descending' }],
      'hint'
    )
    expect(html).toContain('[multi_choice, descending]')
  })
})

// ----- DOM round-trip and interaction tests -----

let dom: AppDom | null = null

afterEach(() => {
  dom?.close()
  dom = null
})

const PROJECT = { id: 'p1', name: 'Startlap' }
const PERSONA = {
  id: 'per1',
  projectId: 'p1',
  lineageId: 'per1',
  name: 'Anna',
  version: 1,
  isLatest: true,
  demographics: { hírérdeklődés: COLON_VALUE, kor: '34' },
  biography: 'Budapesti tanár.',
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
    { id: 'q1', text: 'Milyen csatornákat használsz?', options: ['Újság', 'App', 'TV'], scaleType: 'multi_choice', scaleDirection: 'descending' }
  ]
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
    'GET /api/runs': [],
    ...overrides
  })
}

function selectProject(d: AppDom, id = 'p1'): void {
  ;(d.window as unknown as { selectProjectEverywhere: (id: string) => void }).selectProjectEverywhere(id)
}

async function openPersonaEdit(d: AppDom): Promise<void> {
  selectProject(d)
  await d.settle()
  d.document.querySelector('[data-entity="personas"]')!.click()
  await d.settle()
  d.document.querySelector('[data-action="edit-persona"]')!.click()
  await d.settle()
}

async function openQuestionnaireEdit(d: AppDom): Promise<void> {
  const select = d.document.getElementById('questionnaireProjectSelect')!
  select.value = 'p1'
  select.dispatchEvent(new d.window.Event('change', { bubbles: true }))
  await d.settle()
  d.document.querySelector('[data-entity="questionnaires"]')!.click()
  await d.settle()
  d.document.querySelector('[data-action="edit-questionnaire"]')!.click()
  await d.settle()
}

describe('persona version edit — structured demographics/provenance editor', () => {
  it('round-trips a colon-laden demographic value untouched', async () => {
    let posted: { demographics?: Record<string, string> } | null = null
    dom = loadAppDom({
      routes: entityRoutes({
        'POST /api/personas/per1/versions': (body: unknown) => {
          posted = body as { demographics?: Record<string, string> }
          return { id: 'per2' }
        },
        'GET /api/personas/per2': { ...PERSONA, id: 'per2', version: 2 },
        'GET /api/personas/per2/versions': [PERSONA, { ...PERSONA, id: 'per2', version: 2 }]
      })
    })
    await dom.boot()
    await openPersonaEdit(dom)
    dom.document
      .getElementById('personaVersionForm')!
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    await dom.settle()
    expect(posted).not.toBeNull()
    expect((posted as unknown as { demographics: Record<string, string> }).demographics).toEqual(PERSONA.demographics)
  })

  it('round-trips the provenance untouched', async () => {
    let posted: { provenance?: Record<string, string> } | null = null
    dom = loadAppDom({
      routes: entityRoutes({
        'POST /api/personas/per1/versions': (body: unknown) => {
          posted = body as { provenance?: Record<string, string> }
          return { id: 'per2' }
        },
        'GET /api/personas/per2': { ...PERSONA, id: 'per2', version: 2 },
        'GET /api/personas/per2/versions': [PERSONA, { ...PERSONA, id: 'per2', version: 2 }]
      })
    })
    await dom.boot()
    await openPersonaEdit(dom)
    dom.document
      .getElementById('personaVersionForm')!
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    await dom.settle()
    expect((posted as unknown as { provenance: Record<string, string> }).provenance).toEqual(PERSONA.provenance)
  })

  it('keeps the format hint visible after typing, unlike a placeholder', async () => {
    dom = loadAppDom({ routes: entityRoutes() })
    await dom.boot()
    await openPersonaEdit(dom)
    const hintSelector = '[data-kv-editor="personaVersionDemographics"] .form-note'
    const before = dom.document.querySelector(hintSelector)!.textContent
    expect(before).toBeTruthy()
    const keyInputs = dom.document.querySelectorAll('[data-kv-editor="personaVersionDemographics"] [data-kv-key]')
    keyInputs[0]!.value = 'megváltoztatva'
    keyInputs[0]!.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    await dom.settle()
    expect(dom.document.querySelector(hintSelector)!.textContent).toBe(before)
  })

  it('shows immediate feedback that tracks row edits', async () => {
    dom = loadAppDom({ routes: entityRoutes() })
    await dom.boot()
    await openPersonaEdit(dom)
    const feedbackSelector = '[data-kv-editor="personaVersionDemographics"] [data-kv-feedback]'
    expect(dom.document.querySelector(feedbackSelector)!.textContent).toContain('hírérdeklődés')
    dom.document.querySelectorAll('[data-kv-editor="personaVersionDemographics"] [data-kv-remove]')[0]!.click()
    await dom.settle()
    expect(dom.document.querySelector(feedbackSelector)!.textContent).not.toContain('hírérdeklődés')
    expect(dom.document.querySelector(feedbackSelector)!.textContent).toContain('kor')
  })

  it('adds a new demographics row via the button and saves it', async () => {
    let posted: { demographics?: Record<string, string> } | null = null
    dom = loadAppDom({
      routes: entityRoutes({
        'POST /api/personas/per1/versions': (body: unknown) => {
          posted = body as { demographics?: Record<string, string> }
          return { id: 'per2' }
        },
        'GET /api/personas/per2': { ...PERSONA, id: 'per2', version: 2 },
        'GET /api/personas/per2/versions': [PERSONA, { ...PERSONA, id: 'per2', version: 2 }]
      })
    })
    await dom.boot()
    await openPersonaEdit(dom)
    dom.document.querySelector('[data-kv-editor="personaVersionDemographics"] [data-kv-add]')!.click()
    await dom.settle()
    const keyInputs = dom.document.querySelectorAll('[data-kv-editor="personaVersionDemographics"] [data-kv-key]')
    const valueInputs = dom.document.querySelectorAll('[data-kv-editor="personaVersionDemographics"] [data-kv-value]')
    keyInputs[keyInputs.length - 1]!.value = 'foglalkozás'
    keyInputs[keyInputs.length - 1]!.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    valueInputs[valueInputs.length - 1]!.value = 'tanár: általános iskola'
    valueInputs[valueInputs.length - 1]!.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    dom.document
      .getElementById('personaVersionForm')!
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    await dom.settle()
    expect((posted as unknown as { demographics: Record<string, string> }).demographics).toEqual({
      ...PERSONA.demographics,
      foglalkozás: 'tanár: általános iskola'
    })
  })

  it('removes a demographics row via the button and drops it from the save', async () => {
    let posted: { demographics?: Record<string, string> } | null = null
    dom = loadAppDom({
      routes: entityRoutes({
        'POST /api/personas/per1/versions': (body: unknown) => {
          posted = body as { demographics?: Record<string, string> }
          return { id: 'per2' }
        },
        'GET /api/personas/per2': { ...PERSONA, id: 'per2', version: 2 },
        'GET /api/personas/per2/versions': [PERSONA, { ...PERSONA, id: 'per2', version: 2 }]
      })
    })
    await dom.boot()
    await openPersonaEdit(dom)
    dom.document.querySelectorAll('[data-kv-editor="personaVersionDemographics"] [data-kv-remove]')[0]!.click()
    await dom.settle()
    dom.document
      .getElementById('personaVersionForm')!
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    await dom.settle()
    expect((posted as unknown as { demographics: Record<string, string> }).demographics).toEqual({ kor: '34' })
  })
})

describe('questionnaire version edit — structured question/option editor', () => {
  it('blocks an option edit that would silently keep stale reference optionIndexes', async () => {
    let posted = false
    const referenced = {
      ...QUESTIONNAIRE,
      questions: [{
        ...QUESTIONNAIRE.questions[0]!,
        metadata: { _reference: { ertek: '60%', forras: 'KSH', ev: '2025', referenceShare: 0.6, optionIndexes: [0, 2] } }
      }]
    }
    dom = loadAppDom({
      routes: entityRoutes({
        'GET /api/questionnaires': [referenced],
        'GET /api/questionnaires/qn1': referenced,
        'GET /api/questionnaires/qn1/versions': [referenced],
        'POST /api/questionnaires/qn1/versions': () => {
          posted = true
          return { id: 'qn2' }
        }
      })
    })
    await dom.boot()
    await openQuestionnaireEdit(dom)
    const firstOption = dom.document.querySelector('[data-q-editor="questionnaireVersionText"] [data-q-option-text]')!
    firstOption.value = 'Teljesen más opció'
    firstOption.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    dom.document.getElementById('questionnaireVersionForm')!
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    await dom.settle()

    expect(posted).toBe(false)
    expect(dom.document.getElementById('questionnaireVersionError')!.textContent).toMatch(/referencia|metaadat|opció/i)
  })

  it('round-trips a multi-select, descending question untouched (text, options, scale, order)', async () => {
    let posted: { questions?: unknown[] } | null = null
    dom = loadAppDom({
      routes: entityRoutes({
        'POST /api/questionnaires/qn1/versions': (body: unknown) => {
          posted = body as { questions?: unknown[] }
          return { id: 'qn2' }
        },
        'GET /api/questionnaires/qn2': { ...QUESTIONNAIRE, id: 'qn2', version: 2 },
        'GET /api/questionnaires/qn2/versions': [QUESTIONNAIRE, { ...QUESTIONNAIRE, id: 'qn2', version: 2 }]
      })
    })
    await dom.boot()
    await openQuestionnaireEdit(dom)
    dom.document
      .getElementById('questionnaireVersionForm')!
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    await dom.settle()
    expect(posted).not.toBeNull()
    expect((posted as unknown as { questions: unknown[] }).questions).toEqual([
      {
        text: 'Milyen csatornákat használsz?',
        options: ['Újság', 'App', 'TV'],
        scaleType: 'multi_choice',
        scaleDirection: 'descending'
      }
    ])
  })

  it('removes an option via the button while keeping the scale marker intact', async () => {
    let posted: { questions?: { options: string[]; scaleType?: string; scaleDirection?: string }[] } | null = null
    dom = loadAppDom({
      routes: entityRoutes({
        'POST /api/questionnaires/qn1/versions': (body: unknown) => {
          posted = body as typeof posted
          return { id: 'qn2' }
        },
        'GET /api/questionnaires/qn2': { ...QUESTIONNAIRE, id: 'qn2', version: 2 },
        'GET /api/questionnaires/qn2/versions': [QUESTIONNAIRE, { ...QUESTIONNAIRE, id: 'qn2', version: 2 }]
      })
    })
    await dom.boot()
    await openQuestionnaireEdit(dom)
    // Remove the middle option ("App").
    dom.document.querySelectorAll('[data-q-editor="questionnaireVersionText"] [data-q-option-remove]')[1]!.click()
    await dom.settle()
    dom.document
      .getElementById('questionnaireVersionForm')!
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    await dom.settle()
    expect(posted!.questions![0]!.options).toEqual(['Újság', 'TV'])
    expect(posted!.questions![0]!.scaleType).toBe('multi_choice')
    expect(posted!.questions![0]!.scaleDirection).toBe('descending')
  })

  it('adds a new question block with its own options via the buttons', async () => {
    let posted: { questions?: { text: string; options: string[] }[] } | null = null
    dom = loadAppDom({
      routes: entityRoutes({
        'POST /api/questionnaires/qn1/versions': (body: unknown) => {
          posted = body as typeof posted
          return { id: 'qn2' }
        },
        'GET /api/questionnaires/qn2': { ...QUESTIONNAIRE, id: 'qn2', version: 2 },
        'GET /api/questionnaires/qn2/versions': [QUESTIONNAIRE, { ...QUESTIONNAIRE, id: 'qn2', version: 2 }]
      })
    })
    await dom.boot()
    await openQuestionnaireEdit(dom)
    dom.document.querySelector('[data-q-editor="questionnaireVersionText"] [data-q-block-add]')!.click()
    await dom.settle()
    const textInputs = dom.document.querySelectorAll('[data-q-editor="questionnaireVersionText"] [data-q-text]')
    textInputs[textInputs.length - 1]!.value = 'Új kérdés?'
    textInputs[textInputs.length - 1]!.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    const newBlock = dom.document.querySelectorAll('[data-q-editor="questionnaireVersionText"] [data-q-block]')[1]!
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const optionInputs = (newBlock as any).querySelectorAll('[data-q-option-text]')
    optionInputs[0].value = 'Igen'
    optionInputs[0].dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    optionInputs[1].value = 'Nem'
    optionInputs[1].dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    await dom.settle()
    dom.document
      .getElementById('questionnaireVersionForm')!
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    await dom.settle()
    expect(posted!.questions).toHaveLength(2)
    // The picker panel (issue #31, unaffected by this change) always attaches
    // a scale type/direction to every saved question — this test's own
    // concern is only that the structured editor captured the right text and
    // options for the newly added question.
    expect(posted!.questions![1]).toMatchObject({ text: 'Új kérdés?', options: ['Igen', 'Nem'] })
  })

  it('shows immediate feedback on how many questions will actually be saved', async () => {
    dom = loadAppDom({ routes: entityRoutes() })
    await dom.boot()
    await openQuestionnaireEdit(dom)
    const feedback = dom.document.querySelector('[data-q-editor="questionnaireVersionText"] [data-q-feedback]')!.textContent
    expect(feedback).toContain('1')
  })
})

describe('persona create form — structured demographics editor', () => {
  it('builds demographics from structured rows, preserving a colon inside the value', async () => {
    let posted: { demographics?: Record<string, string> } | null = null
    dom = loadAppDom({
      routes: entityRoutes({
        'POST /api/personas': (body: unknown) => {
          posted = body as { demographics?: Record<string, string> }
          return { id: 'newp' }
        }
      })
    })
    await dom.boot()
    selectProject(dom)
    await dom.settle()
    dom.document.getElementById('personaName')!.value = 'Béla'
    const keyInputs = dom.document.querySelectorAll('[data-kv-editor="personaDemographics"] [data-kv-key]')
    const valueInputs = dom.document.querySelectorAll('[data-kv-editor="personaDemographics"] [data-kv-value]')
    keyInputs[0]!.value = 'hírérdeklődés'
    keyInputs[0]!.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    valueInputs[0]!.value = COLON_VALUE
    valueInputs[0]!.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    dom.document
      .getElementById('personaForm')!
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    await dom.settle()
    expect(posted).not.toBeNull()
    expect((posted as unknown as { demographics: Record<string, string> }).demographics).toEqual({
      hírérdeklődés: COLON_VALUE
    })
  })
})

describe('questionnaire create form — structured question editor', () => {
  it('builds a question with its options from structured rows', async () => {
    let posted: { questions?: { text: string; options: string[] }[] } | null = null
    dom = loadAppDom({
      routes: entityRoutes({
        'POST /api/questionnaires': (body: unknown) => {
          posted = body as typeof posted
          return { id: 'newq' }
        }
      })
    })
    await dom.boot()
    dom.document.getElementById('questionnaireName')!.value = 'Új kérdőív'
    dom.document.querySelector('[data-q-editor="questionsText"] [data-q-text]')!.value = 'Szereted?'
    dom.document
      .querySelector('[data-q-editor="questionsText"] [data-q-text]')!
      .dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    const optionInputs = dom.document.querySelectorAll('[data-q-editor="questionsText"] [data-q-option-text]')
    optionInputs[0]!.value = 'Igen'
    optionInputs[0]!.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    optionInputs[1]!.value = 'Nem'
    optionInputs[1]!.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    dom.document
      .getElementById('questionnaireForm')!
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    await dom.settle()
    expect(posted).not.toBeNull()
    // Same as the version-edit "adds a new question block" test: the picker
    // panel (issue #31) always attaches a default scale type/direction.
    expect(posted!.questions).toMatchObject([{ text: 'Szereted?', options: ['Igen', 'Nem'] }])
  })
})
