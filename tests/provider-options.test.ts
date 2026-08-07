import { describe, it, expect } from 'vitest'
import { buildProviderOptions } from '../src/lib/provider-options.js'

/**
 * Issue #28: the "Szolgáltató rögzítése" field used to expect a hand-typed
 * OpenRouter provider slug (e.g. `deepinfra/fp4` vs `DeepInfra` — the two are
 * NOT interchangeable, and nothing in the UI explained the difference). This
 * merges two sources into one option list: what the database has actually
 * seen answer for this model (`responses.provider` — real observed data), and,
 * when reachable, OpenRouter's live endpoint catalog for the model (which
 * carries the exact pin-able slug and its quantization).
 */
describe('buildProviderOptions', () => {
  it('uses the database alone when the catalog is unreachable, ranked by how often observed', () => {
    const options = buildProviderOptions(
      [
        { provider: 'DeepInfra', count: 3 },
        { provider: 'Fireworks', count: 9 }
      ],
      null
    )
    expect(options.map((o) => o.value)).toEqual(['Fireworks', 'DeepInfra'])
    expect(options[0]).toMatchObject({ providerName: 'Fireworks', observedCount: 9, source: 'observed', quantization: null })
  })

  it('returns an empty list when neither source has anything', () => {
    expect(buildProviderOptions([], null)).toEqual([])
    expect(buildProviderOptions([], [])).toEqual([])
  })

  it('merges a catalog match with its observed count, keyed case-insensitively by provider name', () => {
    const options = buildProviderOptions(
      [{ provider: 'deepinfra', count: 5 }],
      [{ tag: 'deepinfra/fp4', providerName: 'DeepInfra', quantization: 'fp4' }]
    )
    expect(options).toEqual([
      { value: 'deepinfra/fp4', providerName: 'DeepInfra', quantization: 'fp4', observedCount: 5, source: 'both' }
    ])
  })

  it('lists a catalog-only provider (never observed) after every observed one', () => {
    const options = buildProviderOptions(
      [{ provider: 'DeepInfra', count: 2 }],
      [
        { tag: 'deepinfra/fp4', providerName: 'DeepInfra', quantization: 'fp4' },
        { tag: 'novita', providerName: 'Novita', quantization: 'unknown' }
      ]
    )
    expect(options.map((o) => o.providerName)).toEqual(['DeepInfra', 'Novita'])
    expect(options[1]).toMatchObject({ value: 'novita', source: 'catalog', observedCount: null })
  })

  it('keeps a provider the database saw but the current catalog no longer lists', () => {
    const options = buildProviderOptions(
      [{ provider: 'RetiredProvider', count: 1 }],
      [{ tag: 'deepinfra/fp4', providerName: 'DeepInfra', quantization: 'fp4' }]
    )
    expect(options.some((o) => o.providerName === 'RetiredProvider' && o.source === 'observed')).toBe(true)
  })

  // 'unknown' from the API is OpenRouter saying it does not know — reported as
  // null, never displayed as if "unknown" were itself a quantization level.
  it('normalizes catalog quantization "unknown" to null', () => {
    const options = buildProviderOptions([], [{ tag: 'azure', providerName: 'Azure', quantization: 'unknown' }])
    expect(options[0]!.quantization).toBeNull()
  })
})
