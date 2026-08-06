import { describe, it, expect } from 'vitest'
import { loadPublicScript } from './helpers/load-public-script.js'

const { diffVersions, renderVersionDiff, hasComparableFields } = loadPublicScript<{
  diffVersions: (prev: Record<string, unknown>, curr: Record<string, unknown>) => Array<{
    field: string
    kind: 'added' | 'removed' | 'changed'
    from: unknown
    to: unknown
  }>
  renderVersionDiff: (changes: Array<{ field: string; kind: string; from: unknown; to: unknown }>) => string
  hasComparableFields: (obj: Record<string, unknown>) => boolean
}>(['format.js', 'version-diff.js'], '{ diffVersions, renderVersionDiff, hasComparableFields }')

describe('diffVersions', () => {
  it('returns empty array when nothing changed', () => {
    const persona = { name: 'Anna', biography: 'Budapest', renderingStyle: 'bulleted_profile' }
    const changes = diffVersions(persona, persona)
    expect(changes).toEqual([])
  })

  it('detects a scalar field addition', () => {
    const changes = diffVersions({}, { name: 'Anna' })
    expect(changes).toHaveLength(1)
    expect(changes[0]).toEqual({ field: 'name', kind: 'added', from: null, to: 'Anna' })
  })

  it('detects a scalar field removal', () => {
    const changes = diffVersions({ name: 'Anna' }, {})
    expect(changes).toHaveLength(1)
    expect(changes[0]).toEqual({ field: 'name', kind: 'removed', from: 'Anna', to: null })
  })

  it('detects a scalar field change', () => {
    const changes = diffVersions({ name: 'Anna' }, { name: 'Brigitta' })
    expect(changes).toHaveLength(1)
    expect(changes[0]).toEqual({ field: 'name', kind: 'changed', from: 'Anna', to: 'Brigitta' })
  })

  it('treats null, undefined, and empty string as absent', () => {
    const v1 = { name: '' }
    const v2 = { name: null }
    const v3 = { name: undefined }
    const v4 = {}

    expect(diffVersions(v1, v2)).toEqual([])
    expect(diffVersions(v2, v3)).toEqual([])
    expect(diffVersions(v3, v4)).toEqual([])
    expect(diffVersions(v1, { name: 'Anna' })).toHaveLength(1)
    expect(diffVersions(v1, { name: 'Anna' })[0]!.kind).toBe('added')
  })

  it('detects nested demographics addition', () => {
    const changes = diffVersions({ demographics: {} }, { demographics: { kor: '34' } })
    expect(changes).toHaveLength(1)
    expect(changes[0]).toEqual({ field: 'demographics.kor', kind: 'added', from: null, to: '34' })
  })

  it('detects nested demographics removal', () => {
    const changes = diffVersions({ demographics: { kor: '34' } }, { demographics: {} })
    expect(changes).toHaveLength(1)
    expect(changes[0]).toEqual({ field: 'demographics.kor', kind: 'removed', from: '34', to: null })
  })

  it('detects nested demographics change', () => {
    const changes = diffVersions(
      { demographics: { kor: '34', nem: 'nő' } },
      { demographics: { kor: '35', nem: 'nő' } }
    )
    expect(changes).toHaveLength(1)
    expect(changes[0]).toEqual({ field: 'demographics.kor', kind: 'changed', from: '34', to: '35' })
  })

  it('reports nested keys alphabetically', () => {
    const changes = diffVersions(
      {},
      { demographics: { zebra: '1', apple: '2', monkey: '3' } }
    )
    expect(changes.map((c) => c.field)).toEqual([
      'demographics.apple',
      'demographics.monkey',
      'demographics.zebra'
    ])
  })

  it('reports scalar fields before nested ones', () => {
    const changes = diffVersions({}, { name: 'Anna', biography: 'Tanár', demographics: { kor: '34' } })
    // Scalar order: name, biography, renderingStyle (renderingStyle absent so 2 changes)
    // Then nested: demographics.kor
    expect(changes.map((c) => c.field)).toEqual(['name', 'biography', 'demographics.kor'])
  })

  it('handles multiple nested additions and removals', () => {
    const prev = {
      demographics: { kor: '34', város: 'Budapest' },
      provenance: { forrás: 'KSH' }
    }
    const curr = {
      demographics: { kor: '35' },
      provenance: { forrás: 'KSH', arány: '12%' }
    }
    const changes = diffVersions(prev, curr)
    expect(changes).toContainEqual({ field: 'demographics.kor', kind: 'changed', from: '34', to: '35' })
    expect(changes).toContainEqual({ field: 'demographics.város', kind: 'removed', from: 'Budapest', to: null })
    expect(changes).toContainEqual({ field: 'provenance.arány', kind: 'added', from: null, to: '12%' })
  })

  it('detects added question', () => {
    const prev = { questions: [] }
    const curr = {
      questions: [
        { id: '1', text: 'Mi a neved?', options: ['A', 'B'], scaleType: 'multi', scaleDirection: 'asc' }
      ]
    }
    const changes = diffVersions(prev, curr)
    expect(changes).toHaveLength(1)
    expect(changes[0]!.field).toBe('kérdés 1')
    expect(changes[0]!.kind).toBe('added')
    expect(changes[0]!.to).toEqual(curr.questions[0])
  })

  it('detects removed question', () => {
    const prev = {
      questions: [
        { id: '1', text: 'Mi a neved?', options: ['A', 'B'], scaleType: 'multi', scaleDirection: 'asc' }
      ]
    }
    const curr = { questions: [] }
    const changes = diffVersions(prev, curr)
    expect(changes).toHaveLength(1)
    expect(changes[0]!.field).toBe('kérdés 1')
    expect(changes[0]!.kind).toBe('removed')
    expect(changes[0]!.from).toEqual(prev.questions[0])
  })

  it('detects changed question text', () => {
    const prev = {
      questions: [
        { id: '1', text: 'Mi a neved?', options: ['A', 'B'], scaleType: 'multi', scaleDirection: 'asc' }
      ]
    }
    const curr = {
      questions: [
        { id: '1', text: 'Hogyan hívnak?', options: ['A', 'B'], scaleType: 'multi', scaleDirection: 'asc' }
      ]
    }
    const changes = diffVersions(prev, curr)
    expect(changes).toHaveLength(1)
    expect(changes[0]!.field).toBe('kérdés 1 szövege')
    expect(changes[0]!.kind).toBe('changed')
    expect(changes[0]!.from).toBe('Mi a neved?')
    expect(changes[0]!.to).toBe('Hogyan hívnak?')
  })

  it('detects changed question options', () => {
    const prev = {
      questions: [
        { id: '1', text: 'Mi a neved?', options: ['A', 'B'], scaleType: 'multi', scaleDirection: 'asc' }
      ]
    }
    const curr = {
      questions: [
        {
          id: '1',
          text: 'Mi a neved?',
          options: ['A', 'B', 'C'],
          scaleType: 'multi',
          scaleDirection: 'asc'
        }
      ]
    }
    const changes = diffVersions(prev, curr)
    expect(changes).toHaveLength(1)
    expect(changes[0]!.field).toBe('kérdés 1 opciói')
    expect(changes[0]!.kind).toBe('changed')
    expect(changes[0]!.from).toEqual(['A', 'B'])
    expect(changes[0]!.to).toEqual(['A', 'B', 'C'])
  })

  it('detects changed question scaleType', () => {
    const prev = {
      questions: [
        { id: '1', text: 'Mi a neved?', options: ['A', 'B'], scaleType: 'multi', scaleDirection: 'asc' }
      ]
    }
    const curr = {
      questions: [
        { id: '1', text: 'Mi a neved?', options: ['A', 'B'], scaleType: 'likert', scaleDirection: 'asc' }
      ]
    }
    const changes = diffVersions(prev, curr)
    expect(changes).toHaveLength(1)
    expect(changes[0]!.field).toBe('kérdés 1 típusa')
    expect(changes[0]!.kind).toBe('changed')
    expect(changes[0]!.from).toBe('multi')
    expect(changes[0]!.to).toBe('likert')
  })

  it('detects changed question scaleDirection', () => {
    const prev = {
      questions: [
        { id: '1', text: 'Mi a neved?', options: ['A', 'B'], scaleType: 'multi', scaleDirection: 'asc' }
      ]
    }
    const curr = {
      questions: [
        { id: '1', text: 'Mi a neved?', options: ['A', 'B'], scaleType: 'multi', scaleDirection: 'desc' }
      ]
    }
    const changes = diffVersions(prev, curr)
    expect(changes).toHaveLength(1)
    expect(changes[0]!.field).toBe('kérdés 1 skálairánya')
    expect(changes[0]!.kind).toBe('changed')
    expect(changes[0]!.from).toBe('asc')
    expect(changes[0]!.to).toBe('desc')
  })

  it('detects multiple changes in a single question', () => {
    const prev = {
      questions: [
        { id: '1', text: 'Mi a neved?', options: ['A', 'B'], scaleType: 'multi', scaleDirection: 'asc' }
      ]
    }
    const curr = {
      questions: [
        {
          id: '1',
          text: 'Hogyan hívnak?',
          options: ['X', 'Y', 'Z'],
          scaleType: 'likert',
          scaleDirection: 'desc'
        }
      ]
    }
    const changes = diffVersions(prev, curr)
    expect(changes).toHaveLength(4)
    expect(changes.map((c) => c.field)).toEqual([
      'kérdés 1 szövege',
      'kérdés 1 opciói',
      'kérdés 1 típusa',
      'kérdés 1 skálairánya'
    ])
  })

  it('handles multiple questions with different changes', () => {
    const prev = {
      questions: [
        { id: '1', text: 'Kérdés 1', options: ['A', 'B'], scaleType: 'multi', scaleDirection: 'asc' },
        { id: '2', text: 'Kérdés 2', options: ['X', 'Y'], scaleType: 'likert', scaleDirection: 'asc' }
      ]
    }
    const curr = {
      questions: [
        { id: '1', text: 'Kérdés 1 módosított', options: ['A', 'B'], scaleType: 'multi', scaleDirection: 'asc' },
        { id: '2', text: 'Kérdés 2', options: ['X', 'Y'], scaleType: 'likert', scaleDirection: 'asc' },
        { id: '3', text: 'Kérdés 3', options: ['1', '2'], scaleType: 'binary', scaleDirection: 'asc' }
      ]
    }
    const changes = diffVersions(prev, curr)
    expect(changes).toContainEqual({
      field: 'kérdés 1 szövege',
      kind: 'changed',
      from: 'Kérdés 1',
      to: 'Kérdés 1 módosított'
    })
    expect(changes).toContainEqual({
      field: 'kérdés 3',
      kind: 'added',
      from: null,
      to: curr.questions[2]
    })
  })

  it('reports question changes after scalar and nested changes', () => {
    const prev = { name: 'v1', demographics: { kor: '34' }, questions: [] }
    const curr = {
      name: 'v2',
      demographics: { kor: '34' },
      questions: [{ id: '1', text: 'Q1', options: [], scaleType: 'multi', scaleDirection: 'asc' }]
    }
    const changes = diffVersions(prev, curr)
    expect(changes.map((c) => c.field)).toEqual(['name', 'kérdés 1'])
  })

  it('handles questionnaire with no changes', () => {
    const q = {
      questions: [
        { id: '1', text: 'Q1', options: ['A', 'B'], scaleType: 'multi', scaleDirection: 'asc' }
      ]
    }
    const changes = diffVersions(q, q)
    expect(changes).toEqual([])
  })
})

describe('renderVersionDiff', () => {
  it('shows a note when no changes', () => {
    const html = renderVersionDiff([])
    expect(html).toContain('Ebben a verzióban nem történt változás.')
    expect(html).toContain('detail-note')
  })

  it('renders a single addition', () => {
    const changes = [{ field: 'name', kind: 'added', from: null, to: 'Anna' }]
    const html = renderVersionDiff(changes)
    expect(html).toContain('name')
    expect(html).toContain('Anna')
    expect(html).toContain('új')
    expect(html).toContain('<ul class="version-diff">')
  })

  it('renders a single removal', () => {
    const changes = [{ field: 'name', kind: 'removed', from: 'Anna', to: null }]
    const html = renderVersionDiff(changes)
    expect(html).toContain('name')
    expect(html).toContain('Anna')
    expect(html).toContain('törölve')
  })

  it('renders a single change', () => {
    const changes = [{ field: 'name', kind: 'changed', from: 'Anna', to: 'Brigitta' }]
    const html = renderVersionDiff(changes)
    expect(html).toContain('name')
    expect(html).toContain('Anna')
    expect(html).toContain('Brigitta')
    expect(html).toContain('→')
  })

  it('escapes field names', () => {
    const changes = [{ field: 'demographics.<script>', kind: 'added', from: null, to: 'x' }]
    const html = renderVersionDiff(changes)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('escapes values', () => {
    const changes = [
      { field: 'biography', kind: 'added', from: null, to: '<img src=x onerror=alert(1)>' }
    ]
    const html = renderVersionDiff(changes)
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img')
  })

  it('escapes quotes in values', () => {
    const changes = [{ field: 'name', kind: 'changed', from: 'Anna "The Great"', to: 'Bob' }]
    const html = renderVersionDiff(changes)
    expect(html).toContain('&quot;')
    expect(html).not.toContain('Anna "The Great"')
  })

  it('handles object values (demographics) by JSON-stringifying and escaping', () => {
    const changes = [
      {
        field: 'provenance',
        kind: 'added',
        from: null,
        to: { forrás: 'KSH', arány: '12%' }
      }
    ]
    const html = renderVersionDiff(changes)
    expect(html).toContain('új')
    // JSON stringified and escaped
    expect(html).toContain('&quot;')
    expect(html).toContain('KSH')
  })

  it('wraps values in version-diff-value spans', () => {
    const changes = [{ field: 'name', kind: 'changed', from: 'Anna', to: 'Brigitta' }]
    const html = renderVersionDiff(changes)
    expect(html).toContain('<span class="version-diff-value">')
    expect((html.match(/version-diff-value/g) || []).length).toBe(2)
  })

  it('renders multiple changes as list items', () => {
    const changes = [
      { field: 'name', kind: 'added', from: null, to: 'Anna' },
      { field: 'biography', kind: 'changed', from: 'Old bio', to: 'New bio' },
      { field: 'demographics.kor', kind: 'removed', from: '34', to: null }
    ]
    const html = renderVersionDiff(changes)
    expect((html.match(/<li>/g) || []).length).toBe(3)
    expect(html).toContain('name')
    expect(html).toContain('biography')
    expect(html).toContain('demographics.kor')
  })

  it('handles null from and to values gracefully', () => {
    const changes = [
      { field: 'name', kind: 'added', from: null, to: null },
      { field: 'biography', kind: 'removed', from: undefined, to: null }
    ]
    const html = renderVersionDiff(changes)
    expect(html).toContain('name')
    expect(html).toContain('—')
  })

  it('does not truncate long values', () => {
    const longValue = 'A'.repeat(500)
    const changes = [{ field: 'biography', kind: 'added', from: null, to: longValue }]
    const html = renderVersionDiff(changes)
    expect(html).toContain('A'.repeat(500))
  })

  it('renders question changes with field names in Hungarian', () => {
    const changes = [
      {
        field: 'kérdés 1 szövege',
        kind: 'changed',
        from: 'Régi kérdés',
        to: 'Új kérdés'
      }
    ]
    const html = renderVersionDiff(changes)
    expect(html).toContain('kérdés 1 szövege')
    expect(html).toContain('Régi kérdés')
    expect(html).toContain('Új kérdés')
  })

  it('renders question option changes with comma-separated options', () => {
    const changes = [
      {
        field: 'kérdés 2 opciói',
        kind: 'changed',
        from: ['Igen', 'Nem'],
        to: ['Igen', 'Nem', 'Nem tudom']
      }
    ]
    const html = renderVersionDiff(changes)
    expect(html).toContain('Igen, Nem')
    expect(html).toContain('Igen, Nem, Nem tudom')
    expect(html).not.toContain(JSON.stringify(['Igen', 'Nem']))
  })

  it('escapes question text with malicious content', () => {
    const changes = [
      {
        field: 'kérdés 1 szövege',
        kind: 'changed',
        from: 'Szokásos kérdés',
        to: 'Kérdés <script>alert("XSS")</script>'
      }
    ]
    const html = renderVersionDiff(changes)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('escapes quotes in question text', () => {
    const changes = [
      {
        field: 'kérdés 1 szövege',
        kind: 'changed',
        from: 'Mit gondolsz?',
        to: 'Mit gondolsz a "szabadságról"?'
      }
    ]
    const html = renderVersionDiff(changes)
    expect(html).not.toContain('"szabadságról"')
    expect(html).toContain('&quot;')
  })
})

describe('hasComparableFields', () => {
  it('returns true when object has name', () => {
    expect(hasComparableFields({ name: 'Anna' })).toBe(true)
  })

  it('returns true when object has biography', () => {
    expect(hasComparableFields({ biography: 'Budapest' })).toBe(true)
  })

  it('returns true when object has renderingStyle', () => {
    expect(hasComparableFields({ renderingStyle: 'profile' })).toBe(true)
  })

  it('returns true when object has demographics', () => {
    expect(hasComparableFields({ demographics: { kor: '34' } })).toBe(true)
  })

  it('returns true when object has provenance', () => {
    expect(hasComparableFields({ provenance: { forrás: 'KSH' } })).toBe(true)
  })

  it('returns true when object has questions', () => {
    expect(
      hasComparableFields({
        questions: [{ id: '1', text: 'Q1', options: [], scaleType: 'multi', scaleDirection: 'asc' }]
      })
    ).toBe(true)
  })

  it('returns false for empty object', () => {
    expect(hasComparableFields({})).toBe(false)
  })

  it('returns false for null', () => {
    expect(hasComparableFields(null as any)).toBe(false)
  })

  it('returns false for undefined', () => {
    expect(hasComparableFields(undefined as any)).toBe(false)
  })

  it('returns false when fields are null or undefined', () => {
    expect(hasComparableFields({ name: null, biography: undefined })).toBe(false)
  })

  it('returns true when object has multiple comparable fields', () => {
    expect(
      hasComparableFields({
        name: 'Anna',
        biography: 'Budapest',
        demographics: { kor: '34' },
        questions: []
      })
    ).toBe(true)
  })

  it('returns false when object has no comparable fields but has other properties', () => {
    expect(hasComparableFields({ id: '123', created: '2024-01-01' })).toBe(false)
  })
})
