import { describe, it, expect } from 'vitest'
import { loadPublicScript } from './helpers/load-public-script.js'

const { diffVersions, renderVersionDiff } = loadPublicScript<{
  diffVersions: (prev: Record<string, unknown>, curr: Record<string, unknown>) => Array<{
    field: string
    kind: 'added' | 'removed' | 'changed'
    from: unknown
    to: unknown
  }>
  renderVersionDiff: (changes: Array<{ field: string; kind: string; from: unknown; to: unknown }>) => string
}>(['format.js', 'version-diff.js'], '{ diffVersions, renderVersionDiff }')

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
})
