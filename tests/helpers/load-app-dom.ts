import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Window } from 'happy-dom'

/**
 * Loads the real `public/index.html` and the real view-controller scripts into a
 * DOM, wired to a stubbed API. The view controllers are where the researcher
 * actually reads the data, so they need a test that exercises the same path the
 * browser takes: parse the page, run the scripts, fire DOMContentLoaded, assert
 * on the rendered DOM.
 *
 * The scripts are classic (no bundler, no modules) and share one global scope,
 * so they are concatenated and evaluated together — the same thing the browser
 * does with a series of <script src> tags.
 */

export type StubHandler = (body: unknown, url: string) => unknown | Promise<unknown>

export interface ApiStubOptions {
  /** "GET /api/projects" -> data, or a function receiving the parsed body. */
  routes: Record<string, unknown | StubHandler>
}

export interface StubCall {
  method: string
  url: string
  body: unknown
}

/**
 * happy-dom's DOM classes and TypeScript's built-in lib.dom types are
 * structurally incompatible (readyState alone reduces the intersection to
 * `never`), so the harness hands the tests a minimal local surface instead of
 * pretending the two type worlds are the same.
 */
export interface TestElement {
  textContent: string | null
  innerHTML: string
  className: string
  value: string
  disabled: boolean
  checked: boolean
  style: { display: string }
  isConnected: boolean
  getAttribute(name: string): string | null
  click(): void
  focus(): void
  dispatchEvent(event: unknown): boolean
}

export interface TestDocument {
  getElementById(id: string): TestElement | null
  querySelector(selector: string): TestElement | null
  querySelectorAll(selector: string): readonly TestElement[]
  readonly activeElement: TestElement | null
}

export interface TestWindow {
  location: { hash: string }
  Event: new (type: string, init?: { bubbles?: boolean; cancelable?: boolean }) => unknown
  KeyboardEvent: new (type: string, init?: { key?: string; bubbles?: boolean }) => unknown
}

export interface AppDom {
  window: TestWindow
  document: TestDocument
  calls: StubCall[]
  /** Fires DOMContentLoaded and lets the boot sequence settle. */
  boot(): Promise<void>
  /** Lets pending promises and microtasks run. */
  settle(): Promise<void>
  /** Text of the last alert(), or null. */
  lastAlert(): string | null
  /**
   * Simulates the server pushing one SSE event (app.js's subscribeToEvents
   * listens for 'response' | 'status' | 'evaluation') to whichever
   * EventSource is currently open — the app recreates it on reconnect, so
   * this always targets the latest one, matching what the browser would
   * deliver to. `data` is JSON-stringified, matching the real payload shape
   * (`JSON.parse(e.data)` in every listener).
   */
  emitServerEvent(type: string, data: unknown): void
  close(): void
}

const publicFile = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../public/${name}`, import.meta.url)), 'utf8')

/** Script order taken from index.html so the harness cannot drift from the page. */
function scriptOrder(html: string): string[] {
  return [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]!)
}

export function loadAppDom(options: ApiStubOptions): AppDom {
  const html = publicFile('index.html')
  const window = new Window({ url: 'http://localhost/' })
  const calls: StubCall[] = []
  const alerts: string[] = []

  const w = window as unknown as Record<string, unknown>
  w['alert'] = (message: string): void => {
    alerts.push(String(message))
  }
  // The app opens an SSE stream at boot; there is no server here, and an
  // unstubbed constructor would abort the whole boot sequence. Listeners ARE
  // recorded (not just accepted and discarded) so a test can simulate the
  // server pushing an event via emitServerEvent below — app.js reacts to
  // 'response' | 'status' | 'evaluation' server-sent events, and that
  // reaction is itself part of what some tests need to exercise.
  const eventSourceInstances: { listeners: Record<string, ((e: { data: string }) => void)[]> }[] = []
  w['EventSource'] = class {
    listeners: Record<string, ((e: { data: string }) => void)[]> = {}
    constructor() {
      eventSourceInstances.push(this)
    }
    close(): void {}
    addEventListener(type: string, cb: (e: { data: string }) => void): void {
      ;(this.listeners[type] ??= []).push(cb)
    }
    set onerror(_v: unknown) {}
  }
  w['fetch'] = async (url: string, init?: { method?: string; body?: string }): Promise<unknown> => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(init.body) : null
    calls.push({ method, url, body })
    const key = `${method} ${url.split('?')[0]}`
    const exact = `${method} ${url}`
    const route = options.routes[exact] ?? options.routes[key]
    if (route === undefined) {
      return {
        status: 404,
        json: async () => ({ success: false, error: `No stub for ${exact}` })
      }
    }
    // A handler may return a promise, which lets a test hold one response open
    // and resolve a later one first — the ordering that produces stale renders.
    const data = typeof route === 'function' ? await (route as StubHandler)(body, url) : route
    return { status: 200, json: async () => ({ success: true, data }) }
  }

  // The app's setHash() (public/app.js) navigates via history.replaceState,
  // which real browsers deliberately do NOT turn into a `hashchange` event —
  // only genuine navigation (assigning location.hash/href, back/forward) does.
  // happy-dom does not make that distinction: ANY hash change, however it
  // happened, queues a `hashchange` (see Location's setURL, which every
  // replaceState/pushState call and every location.hash assignment funnels
  // through). Left as-is, every setHash() call would spuriously re-run the
  // app's `hashchange` listener (applyRoute) — a repair the browser never
  // performs — so the suite would be exercising a different state machine
  // than production (issue #21). Only calls originating from
  // history.replaceState are suppressed; a genuine location.hash assignment
  // does not go through the wrapped replaceState below, so it still queues
  // and fires normally.
  let suppressedHashChanges = 0
  const history = window.history as unknown as { replaceState: (...args: unknown[]) => void }
  const originalReplaceState = history.replaceState.bind(window.history)
  history.replaceState = (...args: unknown[]): void => {
    const before = (window.location as unknown as { hash: string }).hash
    originalReplaceState(...args)
    const after = (window.location as unknown as { hash: string }).hash
    // happy-dom only queues a hashchange when the hash actually changed
    // (Location#setURL); only those calls have an event to swallow.
    if (before !== after) suppressedHashChanges++
  }
  const originalDispatchEvent = window.dispatchEvent.bind(window)
  w['dispatchEvent'] = (event: unknown): boolean => {
    const type = (event as { type?: string } | null)?.type
    if (type === 'hashchange' && suppressedHashChanges > 0) {
      suppressedHashChanges--
      return true
    }
    return originalDispatchEvent(event as never)
  }

  ;(window.document as unknown as { write(html: string): void }).write(html)
  // Concatenated, not one eval per file: a classic script's top-level `let`
  // bindings go into the shared global lexical environment, which separate evals
  // do NOT reproduce (app.js declares `let state`, and interview-view.js reads
  // it). One eval per file passes the boot test and then fails everything that
  // touches shared state — the concatenation is what matches the browser.
  const source = scriptOrder(html).map(publicFile).join('\n;\n')
  window.eval(source)

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }

  return {
    window: window as unknown as TestWindow,
    document: window.document as unknown as TestDocument,
    calls,
    async boot() {
      // happy-dom has already finished parsing by the time the scripts are
      // evaluated, so the event they listen for has to be fired explicitly.
      window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }) as never)
      await settle()
    },
    settle,
    lastAlert: () => alerts.at(-1) ?? null,
    emitServerEvent(type: string, data: unknown): void {
      const instance = eventSourceInstances.at(-1)
      const listeners = instance?.listeners[type] ?? []
      const event = { data: JSON.stringify(data) }
      for (const cb of listeners) cb(event)
    },
    close() {
      // Boot starts a progress-polling interval; leaving it running would keep
      // the test process alive and leak one timer per test.
      window.happyDOM.abort()
      void window.close()
    }
  }
}

/** Minimal set of boot responses; individual tests override what they care about. */
export function defaultRoutes(overrides: Record<string, unknown | StubHandler> = {}): Record<
  string,
  unknown | StubHandler
> {
  return {
    'GET /api/session': { authenticated: true },
    'GET /api/models': { default: 'm1', models: [{ id: 'm1', label: 'Modell 1' }] },
    'GET /api/projects': [],
    'GET /api/personas': [],
    'GET /api/questionnaires': [],
    'GET /api/runs': [],
    'GET /api/interviews': [],
    'GET /api/budget': { global: { totalTokens: 0, costUsd: 0 }, limits: { globalBudget: 0, perRunBudget: 0 } },
    ...overrides
  }
}
