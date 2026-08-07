import { describe, it, expect, afterEach } from 'vitest'
import { loadAppDom, defaultRoutes, type AppDom } from './helpers/load-app-dom.js'

/**
 * Collapsible create/edit forms (issue #18). Every creator form starts hidden
 * behind a toggle button, and the list/content of its section is shown first.
 * The toggle is found by its `aria-controls` attribute, which the issue
 * mandates point at the form it opens — that is also the most stable selector,
 * since the visible button label is free-text ("+ Új projekt" etc.).
 */

let dom: AppDom | null = null

afterEach(() => {
  dom?.close()
  dom = null
})

const PROJECT = { id: 'p1', name: 'Startlap', applicationDomain: 'Hírportál', targetPopulation: '18-65' }
const PERSONA = { id: 'per1', projectId: 'p1', name: 'Anna', demographics: { kor: 34 }, version: 1, isLatest: true }

function routes(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return defaultRoutes({
    'GET /api/projects': [PROJECT],
    'GET /api/personas': [PERSONA],
    ...overrides
  })
}

function toggleFor(d: AppDom, formId: string) {
  return d.document.querySelector(`[aria-controls="${formId}"]`)
}

async function selectProject(d: AppDom): Promise<void> {
  const select = d.document.getElementById('runProjectSelect')!
  select.value = 'p1'
  select.dispatchEvent(new d.window.Event('change', { bubbles: true }))
  await d.settle()
}

describe('every creator form is collapsed behind a labelled toggle', () => {
  const FORMS: { id: string; label: RegExp }[] = [
    { id: 'projectForm', label: /új projekt/i },
    { id: 'personaForm', label: /új perszóna/i },
    { id: 'questionnaireForm', label: /új kérdőív/i },
    { id: 'runForm', label: /új futtatás/i },
    { id: 'interviewForm', label: /új interjú/i },
    { id: 'calibrationForm', label: /kalibráció indítása/i },
    { id: 'profileFromRunsForm', label: /profil rögzítése/i }
  ]

  for (const { id, label } of FORMS) {
    it(`${id} has a toggle, starts collapsed and names what it opens`, async () => {
      dom = loadAppDom({ routes: routes() })
      await dom.boot()
      const toggle = toggleFor(dom, id)
      expect(toggle, `toggle for ${id}`).not.toBeNull()
      expect(toggle!.getAttribute('aria-expanded')).toBe('false')
      expect(toggle!.textContent).toMatch(label)
      expect(dom.document.getElementById(id)!.style.display).toBe('none')
    })
  }
})

describe('the list is shown first, the form behind it', () => {
  const ORDER: { formId: string; listId: string; tabId: string }[] = [
    { formId: 'projectForm', listId: 'projectsList', tabId: 'tab-projects' },
    { formId: 'personaForm', listId: 'personasList', tabId: 'tab-personas' },
    { formId: 'questionnaireForm', listId: 'questionnairesList', tabId: 'tab-questionnaires' },
    { formId: 'runForm', listId: 'runsList', tabId: 'tab-runs' },
    { formId: 'interviewForm', listId: 'interviewsList', tabId: 'tab-interviews' }
  ]

  for (const { formId, listId, tabId } of ORDER) {
    it(`${listId} precedes ${formId} in ${tabId}`, async () => {
      dom = loadAppDom({ routes: routes() })
      await dom.boot()
      const html = dom.document.getElementById(tabId)!.innerHTML
      const listPos = html.indexOf(`id="${listId}"`)
      const formPos = html.indexOf(`id="${formId}"`)
      expect(listPos, `${listId} must exist in ${tabId}`).toBeGreaterThanOrEqual(0)
      expect(formPos, `${formId} must exist in ${tabId}`).toBeGreaterThanOrEqual(0)
      expect(listPos).toBeLessThan(formPos)
    })
  }
})

describe('opening and closing the project form', () => {
  it('opens on toggle click and reveals the form', async () => {
    dom = loadAppDom({ routes: routes() })
    await dom.boot()
    const toggle = toggleFor(dom, 'projectForm')!
    toggle.click()
    await dom.settle()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(dom.document.getElementById('projectForm')!.style.display).not.toBe('none')
  })

  it('closes on Escape', async () => {
    dom = loadAppDom({ routes: routes() })
    await dom.boot()
    const toggle = toggleFor(dom, 'projectForm')!
    toggle.click()
    await dom.settle()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    dom.document
      .getElementById('projectForm')!
      .dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await dom.settle()

    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(dom.document.getElementById('projectForm')!.style.display).toBe('none')
  })

  // Rule #5 in the issue: the submit handler itself must not change. What is
  // observable from the outside is that the same request still fires and the
  // form still empties afterwards — plus the new behaviour, collapse + focus.
  it('still submits the existing request, then collapses and returns focus to the toggle', async () => {
    let posted: unknown = null
    dom = loadAppDom({
      routes: routes({
        'POST /api/projects': (body: unknown) => {
          posted = body
          return { id: 'p2' }
        }
      })
    })
    await dom.boot()
    const toggle = toggleFor(dom, 'projectForm')!
    toggle.click()
    await dom.settle()

    ;(dom.document.getElementById('projectName')!).value = 'Új projekt'
    dom.document.querySelector('#projectForm button[type="submit"]')!.click()
    await dom.settle()

    expect(posted).toMatchObject({ name: 'Új projekt' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(dom.document.getElementById('projectForm')!.style.display).toBe('none')
    expect(dom.document.activeElement).toBe(toggle)
  })
})

describe('the persona form toggle lives inside personaFormSection', () => {
  it('is collapsed by default once a project makes the section visible', async () => {
    dom = loadAppDom({ routes: routes() })
    await dom.boot()
    await selectProject(dom)
    const toggle = toggleFor(dom, 'personaForm')!
    const section = dom.document.getElementById('personaFormSection')!
    expect(section.textContent).toContain(toggle.textContent)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(dom.document.getElementById('personaForm')!.style.display).toBe('none')
  })

  it('collapses again and returns focus after a successful submit', async () => {
    dom = loadAppDom({
      routes: routes({
        'POST /api/personas': () => ({ id: 'per2' })
      })
    })
    await dom.boot()
    await selectProject(dom)
    const toggle = toggleFor(dom, 'personaForm')!
    toggle.click()
    await dom.settle()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    ;(dom.document.getElementById('personaName')!).value = 'Béla'
    dom.document.querySelector('#personaForm button[type="submit"]')!.click()
    await dom.settle()

    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(dom.document.activeElement).toBe(toggle)
  })
})

describe('collapsed state does not survive a reload', () => {
  it('starts collapsed again on a fresh boot even after being opened before', async () => {
    dom = loadAppDom({ routes: routes() })
    await dom.boot()
    toggleFor(dom, 'projectForm')!.click()
    await dom.settle()
    expect(toggleFor(dom, 'projectForm')!.getAttribute('aria-expanded')).toBe('true')
    dom.close()

    // A fresh page load: nothing about the previous session's open/closed state
    // may leak in (rule #6 — no persistence across a reload).
    dom = loadAppDom({ routes: routes() })
    await dom.boot()
    expect(toggleFor(dom, 'projectForm')!.getAttribute('aria-expanded')).toBe('false')
    expect(dom.document.getElementById('projectForm')!.style.display).toBe('none')
  })
})
