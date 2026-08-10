import { describe, it, expect, afterEach } from 'vitest'
import { loadAppDom, defaultRoutes, type AppDom } from './helpers/load-app-dom.js'

/**
 * Three-panel app shell (issue #46, first slice — docs/UI-DESIGN.md §1-3).
 *
 * Scope of THIS slice, and therefore of this file: the shell only — three
 * identifiable panels, the existing menu/project-selector/budget-widget
 * relocated (not duplicated) into the left panel, and the Inspector hidden by
 * default. The Analyst/Engineer (X-Ray) toggle and the Inspector's real
 * content are separate slices and are NOT covered here.
 *
 * happy-dom performs no layout, so `100vh`, the CSS grid itself and "no
 * global scroll" are NOT and CANNOT be verified here — that needs a real
 * browser. What follows only asserts DOM structure, attributes and
 * click/keyboard behaviour.
 *
 * Contract this file assumes (documented because none of it is written down
 * elsewhere yet — the implementer should treat this as the spec for the
 * shell's markup, not as an accident of how the test happens to query):
 *
 *  - The left/navigation panel IS the existing `#contextSidebar` (issue #19)
 *    — extended with the tab menu and the token-budget widget as further
 *    children, not a new wrapper element. This keeps every existing
 *    `#contextSidebar ...` assertion in tests/frontend-context-sidebar.test.ts
 *    valid; see this file's tail comment for the one ordering constraint that
 *    follows from that (project `<select>` must stay the first `<select>`).
 *  - The existing tab menu (today `<nav class="tabs">`, a sibling of
 *    `main.tab-content`) is relocated to live INSIDE `#contextSidebar`, as an
 *    actual `<nav>` element (real navigation landmark) — not rebuilt.
 *  - The existing token-budget widget (today `#budgetTokens`/`#budgetLimit`/
 *    `#budgetCost`/`#budgetProgress` inside `.app-header .header-center`) is
 *    relocated into `#contextSidebar` too, reusing the same ids — not
 *    rebuilt, and not left behind as a second copy in the header.
 *  - The workspace panel is the existing `main.tab-content`.
 *  - The Inspector panel is the existing `aside#provenancePanel`.
 *  - A new mobile nav-toggle button, `#contextSidebarToggle`, following the
 *    project's existing aria-expanded/aria-controls pattern (public/collapsible.js).
 *
 * This slice does NOT require removing "Áttekintés", "Projektek" or
 * "Kérdőívek" from the tab set (they are not in docs/UI-DESIGN.md §2's four-
 * item menu, but pruning them is a bigger navigation change than "just the
 * shell" and several already-shipped tests route through them — see this
 * file's final report for that flag).
 */

let dom: AppDom | null = null

afterEach(() => {
  dom?.close()
  dom = null
})

const PROJECT = { id: 'p1', name: 'Startlap' }

function routes(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return defaultRoutes({
    'GET /api/projects': [PROJECT],
    ...overrides
  })
}

// The four menu items docs/UI-DESIGN.md §2 names, mapped to the tab names the
// existing routing (public/routing.js, tests/frontend-routing.test.ts) and
// markup (data-tab=...) already use. "Interjú" in the doc is the existing
// "interviews" tab; "Modellek és kalibráció" is the existing "models" tab.
const MENU_TABS = ['runs', 'personas', 'interviews', 'models']

describe('three identifiable panels', () => {
  it('has a labelled left navigation landmark, a main workspace, and a labelled inspector aside', async () => {
    dom = loadAppDom({ routes: routes() })
    await dom.boot()

    const nav = dom.document.querySelector('aside#contextSidebar')
    expect(nav, 'left/navigation panel: #contextSidebar as an <aside>').not.toBeNull()
    expect(nav!.getAttribute('aria-label')).toBeTruthy()

    const workspace = dom.document.querySelector('main.tab-content')
    expect(workspace, 'workspace panel: main.tab-content').not.toBeNull()

    const inspector = dom.document.querySelector('aside#provenancePanel')
    expect(inspector, 'inspector panel: #provenancePanel as an <aside>').not.toBeNull()
    expect(inspector!.getAttribute('aria-label')).toBeTruthy()
  })

  it('keeps the three panels present after navigating to another tab (not tab-pane-local markup)', async () => {
    dom = loadAppDom({ routes: routes() })
    await dom.boot()
    dom.document.querySelector('[data-tab="interviews"]')!.click()
    await dom.settle()

    expect(dom.document.getElementById('contextSidebar')!.isConnected).toBe(true)
    expect(dom.document.querySelector('main.tab-content')!.isConnected).toBe(true)
    expect(dom.document.getElementById('provenancePanel')!.isConnected).toBe(true)
  })
})

describe('left panel contains the project selector, the menu and the budget widget — relocated, not duplicated', () => {
  it('contains the project selector', async () => {
    dom = loadAppDom({ routes: routes() })
    await dom.boot()
    // Already true today (issue #19) — kept as a regression guard, not a
    // proof of the new shell by itself.
    expect(dom.document.querySelector('#contextSidebar #contextSidebarProjectSelect')).not.toBeNull()
  })

  it('contains the tab menu as a real <nav>, with every one of the four required items', async () => {
    dom = loadAppDom({ routes: routes() })
    await dom.boot()

    expect(
      dom.document.querySelector('#contextSidebar nav'),
      'the menu must be an actual <nav> element nested inside the left panel, not a bag of buttons'
    ).not.toBeNull()

    for (const tab of MENU_TABS) {
      expect(
        dom.document.querySelector(`#contextSidebar [data-tab="${tab}"]`),
        `menu item for data-tab="${tab}" must live inside #contextSidebar`
      ).not.toBeNull()
    }
  })

  it('contains the live token-budget widget (reused ids, not rebuilt)', async () => {
    dom = loadAppDom({ routes: routes() })
    await dom.boot()
    for (const id of ['budgetTokens', 'budgetLimit', 'budgetCost', 'budgetProgress']) {
      expect(
        dom.document.querySelector(`#contextSidebar #${id}`),
        `#${id} must live inside #contextSidebar`
      ).not.toBeNull()
    }
  })

  it('does not leave a second budget widget behind in the header', async () => {
    dom = loadAppDom({ routes: routes() })
    await dom.boot()
    expect(dom.document.querySelectorAll('.budget-widget')).toHaveLength(1)
    expect(dom.document.querySelector('.app-header .budget-widget')).toBeNull()
  })

  it('does not leave a second copy of any of the four menu items outside the left panel', async () => {
    dom = loadAppDom({ routes: routes() })
    await dom.boot()
    for (const tab of MENU_TABS) {
      expect(
        dom.document.querySelectorAll(`[data-tab="${tab}"]`),
        `data-tab="${tab}" must exist exactly once (inside #contextSidebar), never twice`
      ).toHaveLength(1)
    }
  })
})

describe('the relocated menu still routes correctly', () => {
  for (const tab of MENU_TABS) {
    it(`switches to the ${tab} pane and updates the hash`, async () => {
      dom = loadAppDom({ routes: routes() })
      await dom.boot()
      dom.document.querySelector(`#contextSidebar [data-tab="${tab}"]`)!.click()
      await dom.settle()
      expect(dom.document.getElementById(`tab-${tab}`)!.className).toContain('active')
      expect(dom.window.location.hash).toBe(`#${tab}`)
    })
  }

  it('marks the active menu item with aria-current, and only that one', async () => {
    dom = loadAppDom({ routes: routes() })
    await dom.boot()
    dom.document.querySelector('#contextSidebar [data-tab="personas"]')!.click()
    await dom.settle()

    const active = dom.document.querySelector('#contextSidebar [data-tab="personas"]')!
    expect(active.getAttribute('aria-current')).toBeTruthy()

    const others = MENU_TABS.filter((t) => t !== 'personas')
    for (const tab of others) {
      const btn = dom.document.querySelector(`#contextSidebar [data-tab="${tab}"]`)!
      expect(btn.getAttribute('aria-current'), `data-tab="${tab}" must not also be current`).toBeFalsy()
    }
  })

  it('none of the four menu items are pulled out of tab order', async () => {
    dom = loadAppDom({ routes: routes() })
    await dom.boot()
    for (const tab of MENU_TABS) {
      const btn = dom.document.querySelector(`#contextSidebar [data-tab="${tab}"]`)!
      expect(btn.getAttribute('tabindex'), `data-tab="${tab}" must stay keyboard-reachable`).not.toBe('-1')
    }
  })
})

describe('the inspector is hidden by default, and that is readable from the DOM', () => {
  it('starts closed on a fresh boot, before anything is clicked', async () => {
    dom = loadAppDom({ routes: routes() })
    await dom.boot()
    // Same idiom the rest of the suite already uses to assert visibility
    // (tests/frontend-app-dom.test.ts's provenance test, run/entity/interview
    // detail views): an inline style the DOM/JS can read directly, not a
    // stylesheet rule that only a real layout engine could evaluate.
    expect(dom.document.getElementById('provenancePanel')!.style.display).toBe('none')
  })
})

describe('mobile: the left panel can be collapsed and re-expanded from a toggle button', () => {
  it('offers a toggle button describing what it controls', async () => {
    dom = loadAppDom({ routes: routes() })
    await dom.boot()
    const toggle = dom.document.getElementById('contextSidebarToggle')
    expect(toggle, '#contextSidebarToggle must exist').not.toBeNull()
    expect(toggle!.getAttribute('aria-controls')).toBe('contextSidebar')
    expect(toggle!.getAttribute('aria-expanded')).toBeTruthy()
  })

  it('collapses the panel on click, and the collapse is visible to a DOM query (not only in a stylesheet)', async () => {
    dom = loadAppDom({ routes: routes() })
    await dom.boot()
    const toggle = dom.document.getElementById('contextSidebarToggle')!
    const before = toggle.getAttribute('aria-expanded')

    toggle.click()
    await dom.settle()

    expect(toggle.getAttribute('aria-expanded')).not.toBe(before)
    // Same pattern collapsible.js already uses for the entity forms
    // (aria-expanded flips + a class the stylesheet keys off) — reused here,
    // not a new one invented for this widget alone.
    expect(dom.document.getElementById('contextSidebar')!.className).toMatch(/collaps/i)
  })

  it('re-expands on a second click', async () => {
    dom = loadAppDom({ routes: routes() })
    await dom.boot()
    const toggle = dom.document.getElementById('contextSidebarToggle')!
    toggle.click()
    await dom.settle()
    const collapsedState = toggle.getAttribute('aria-expanded')
    toggle.click()
    await dom.settle()
    expect(toggle.getAttribute('aria-expanded')).not.toBe(collapsedState)
    expect(dom.document.getElementById('contextSidebar')!.className).not.toMatch(/collaps/i)
  })
})

// Ordering constraint that follows from reusing #contextSidebar as the left
// panel: tests/frontend-context-sidebar.test.ts's
// "offers every project and syncs..." test reads
// `document.querySelector('#contextSidebar select')` and assumes that is the
// PROJECT select — i.e. the project select must stay the first <select>
// descendant in DOM order. The menu (<button>s) and the budget widget (no
// <select>) do not risk this by themselves, but placement matters if the
// menu or toggle ever grow a <select> of their own.
describe('the project selector stays the first <select> in the left panel (keeps tests/frontend-context-sidebar.test.ts valid)', () => {
  it('is the first <select> under #contextSidebar', async () => {
    dom = loadAppDom({ routes: routes() })
    await dom.boot()
    const first = dom.document.querySelector('#contextSidebar select')!
    expect(first.getAttribute('id')).toBe('contextSidebarProjectSelect')
  })
})
