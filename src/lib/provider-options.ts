/**
 * Issue #28: "Szolgáltató rögzítése" used to be a free-text field expecting the
 * researcher (a media professional, not a developer) to know OpenRouter's
 * internal provider slug from memory — e.g. `deepinfra/fp4` vs `DeepInfra`,
 * which are NOT interchangeable and nowhere explained. This merges the two
 * sources of truth the platform actually has:
 *   - `observed`: providers that have ACTUALLY answered for this model,
 *     read out of `responses.provider` — real data, never rots.
 *   - `catalog`: OpenRouter's live endpoint list for the model, when reachable
 *     — carries the exact pin-able slug (`tag`) and its quantization.
 * Observed data is preferred and ranked first: it is what this deployment's
 * own history has proven to work, not a hardcoded or merely theoretical list.
 */

export interface ObservedProvider {
  provider: string
  count: number
}

export interface CatalogEndpoint {
  /** The exact string OpenRouter's `provider.order` pinning expects. */
  tag: string
  providerName: string
  /** 'unknown' is OpenRouter saying it does not know — never a real level. */
  quantization: string
}

export interface ProviderOption {
  /** What gets submitted as the run's `provider`. */
  value: string
  providerName: string
  quantization: string | null
  observedCount: number | null
  source: 'observed' | 'catalog' | 'both'
}

const normalize = (name: string): string => name.trim().toLowerCase()

/**
 * `catalog === null` means the OpenRouter endpoint list could not be fetched
 * (unreachable, timed out, or this ChatClient does not support it) — the
 * observed list alone still gives real, previously-working options instead of
 * leaving the field with nothing but "Nem rögzítem".
 */
export function buildProviderOptions(
  observed: ObservedProvider[],
  catalog: CatalogEndpoint[] | null
): ProviderOption[] {
  if (catalog === null) {
    return [...observed]
      .sort((a, b) => b.count - a.count)
      .map((o) => ({
        value: o.provider,
        providerName: o.provider,
        quantization: null,
        observedCount: o.count,
        source: 'observed' as const
      }))
  }

  const usedObservedKeys = new Set<string>()
  const fromCatalog: ProviderOption[] = catalog.map((entry) => {
    const match = observed.find((o) => normalize(o.provider) === normalize(entry.providerName))
    if (match) usedObservedKeys.add(normalize(match.provider))
    return {
      value: entry.tag,
      providerName: entry.providerName,
      quantization: entry.quantization === 'unknown' ? null : entry.quantization,
      observedCount: match ? match.count : null,
      source: match ? ('both' as const) : ('catalog' as const)
    }
  })

  // A provider the database saw but the CURRENT catalog no longer lists (the
  // catalog changes over time; the history of what actually served this model
  // does not) — kept, not silently dropped.
  const observedOnly: ProviderOption[] = observed
    .filter((o) => !usedObservedKeys.has(normalize(o.provider)))
    .map((o) => ({
      value: o.provider,
      providerName: o.provider,
      quantization: null,
      observedCount: o.count,
      source: 'observed' as const
    }))

  const seenBefore = [...fromCatalog.filter((o) => o.source === 'both'), ...observedOnly].sort(
    (a, b) => (b.observedCount ?? 0) - (a.observedCount ?? 0)
  )
  const catalogOnly = fromCatalog
    .filter((o) => o.source === 'catalog')
    .sort((a, b) => a.providerName.localeCompare(b.providerName))

  return [...seenBefore, ...catalogOnly]
}
