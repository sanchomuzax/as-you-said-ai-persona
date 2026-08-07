import { describe, it, expect } from 'vitest'
import { loadPublicScript } from './helpers/load-public-script.js'

interface Route {
  tab: string
  runId: string | null
  entityId: string | null
  interviewId: string | null
}

const { parseHash, buildHash } = loadPublicScript<{
  parseHash: (h: string) => Route
  buildHash: (tab: string, id?: string | null) => string
}>('routing.js', '{ parseHash, buildHash }')

describe('parseHash', () => {
  it('defaults to the projects tab', () => {
    expect(parseHash('')).toEqual({ tab: 'projects', runId: null, entityId: null, interviewId: null })
    expect(parseHash('#')).toEqual({ tab: 'projects', runId: null, entityId: null, interviewId: null })
  })

  it('parses plain tab routes', () => {
    expect(parseHash('#personas').tab).toBe('personas')
    expect(parseHash('#runs').tab).toBe('runs')
  })

  it('parses entity detail routes', () => {
    expect(parseHash('#personas/abc-123')).toEqual({ tab: 'personas', runId: null, entityId: 'abc-123', interviewId: null })
    expect(parseHash('#questionnaires/q1')).toEqual({ tab: 'questionnaires', runId: null, entityId: 'q1', interviewId: null })
  })

  it('keeps run details on the runId field', () => {
    expect(parseHash('#runs/r1')).toEqual({ tab: 'runs', runId: 'r1', entityId: null, interviewId: null })
  })

  it('falls back to projects for an unknown route', () => {
    expect(parseHash('#nope')).toEqual({ tab: 'projects', runId: null, entityId: null, interviewId: null })
    expect(parseHash('#nope/123')).toEqual({ tab: 'projects', runId: null, entityId: null, interviewId: null })
  })

  it('keeps interview details on their own field, not the entity view', () => {
    expect(parseHash('#interviews/i1')).toEqual({
      tab: 'interviews',
      runId: null,
      entityId: null,
      interviewId: 'i1'
    })
  })

  it('round-trips ids that need escaping', () => {
    const id = 'a b/c#d'
    expect(parseHash(buildHash('personas', id)).entityId).toBe(id)
  })
})

describe('buildHash', () => {
  it('builds list and detail hashes', () => {
    expect(buildHash('runs', null)).toBe('#runs')
    expect(buildHash('runs', 'r1')).toBe('#runs/r1')
  })
})
