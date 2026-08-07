import { describe, it, expect } from 'vitest'
import { loadPublicScript } from './helpers/load-public-script.js'

/**
 * Issue #28: the provider dropdown's option markup, shared by every form that
 * pins a provider (run/interview/calibration, tab-level and on the model
 * card). Pure string builder, like the rest of model-card.js.
 */
interface ProviderSelectApi {
  renderProviderSelectOptions: (
    options: { value: string; providerName: string; quantization: string | null; observedCount: number | null; source: string }[],
    selectedValue: string
  ) => string
  PROVIDER_FIELD_NOTE: string
}

const api = loadPublicScript<ProviderSelectApi>(
  ['format.js', 'version-diff.js', 'metrics.js', 'detail.js', 'model-card.js'],
  '({ renderProviderSelectOptions, PROVIDER_FIELD_NOTE })'
)

describe('renderProviderSelectOptions', () => {
  it('always offers "Nem rögzítem", selected by default', () => {
    const html = api.renderProviderSelectOptions([], '')
    expect(html).toContain('Nem rögzítem (bármelyik szolgáltató)')
    expect(html).toMatch(/value="" selected/)
  })

  it('lists every option with its quantization spelled out', () => {
    const html = api.renderProviderSelectOptions(
      [{ value: 'deepinfra/fp4', providerName: 'DeepInfra', quantization: 'fp4', observedCount: 5, source: 'both' }],
      ''
    )
    expect(html).toContain('value="deepinfra/fp4"')
    expect(html).toContain('DeepInfra')
    expect(html).toContain('fp4')
  })

  it('selects the matching option and leaves "Nem rögzítem" unselected', () => {
    const html = api.renderProviderSelectOptions(
      [{ value: 'deepinfra/fp4', providerName: 'DeepInfra', quantization: 'fp4', observedCount: 5, source: 'both' }],
      'deepinfra/fp4'
    )
    expect(html).toMatch(/value="deepinfra\/fp4" selected/)
    expect(html).not.toMatch(/value="" selected/)
  })

  it('notes when a catalog option has never actually served this model here', () => {
    const html = api.renderProviderSelectOptions(
      [{ value: 'novita', providerName: 'Novita', quantization: null, observedCount: null, source: 'catalog' }],
      ''
    )
    expect(html).toMatch(/még nem szolgálta ki/)
  })

  it('names how many times an observed provider has actually answered', () => {
    const html = api.renderProviderSelectOptions(
      [{ value: 'DeepInfra', providerName: 'DeepInfra', quantization: null, observedCount: 12, source: 'observed' }],
      ''
    )
    expect(html).toMatch(/12/)
  })

  it('escapes a hostile provider name', () => {
    const html = api.renderProviderSelectOptions(
      [{ value: '<img onerror=alert(1)>', providerName: '<img onerror=alert(1)>', quantization: null, observedCount: 1, source: 'observed' }],
      ''
    )
    expect(html).not.toContain('<img')
  })

  it('explains, in plain language, what quantization is and why pinning matters — not hover-only', () => {
    expect(api.PROVIDER_FIELD_NOTE).toMatch(/kvantálás/)
    expect(api.PROVIDER_FIELD_NOTE.length).toBeGreaterThan(80)
  })

  it('states the reproducibility consequence of not pinning', () => {
    expect(api.PROVIDER_FIELD_NOTE).toMatch(/reproduk/)
  })
})
