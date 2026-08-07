import { describe, it, expect } from 'vitest'
import { promptTemplateHash, LEGACY_TEMPLATE_LANGUAGE, type StoredProfile, type ProfileKey } from '../src/lib/profile.js'
import { stalenessReasons } from '../src/model-profiles.js'

/**
 * Issue #33: the elicitation template is now language-dependent, so its
 * fingerprint (`promptTemplateHash`) must change — every existing profile
 * (all of which predate the language split) must go stale, but the UI text
 * explaining WHY must not read as "something broke".
 */

const baseKey: ProfileKey = {
  modelRequested: 'm1',
  modelVersion: 'm1-2026-05',
  provider: 'DeepInfra',
  promptTemplateHash: 'current-hash',
  probeQuestionnaireId: 'probe-1',
  language: 'hu'
}

function profile(overrides: Partial<StoredProfile> = {}): StoredProfile {
  return {
    id: 'p1',
    ...baseKey,
    promptTemplateHash: 'old-hash',
    metrics: null,
    runIds: ['r1'],
    createdAt: '2026-08-01 10:00:00',
    validUntil: '2026-10-30 10:00:00',
    ...overrides
  }
}

describe('promptTemplateHash', () => {
  it('now covers both template languages, not just English', () => {
    // A regression guard, not a behavioural one: the fingerprint's whole job is
    // to change when ANY branch of the template changes, and language is a new
    // branch. This just proves the function still returns a stable, well-formed
    // digest after that change (the exact value is opaque by design).
    expect(promptTemplateHash()).toMatch(/^[0-9a-f]{16}$/)
    expect(promptTemplateHash()).toBe(promptTemplateHash())
  })
})

describe('stalenessReasons — language-aware wording', () => {
  it('explains a legacy (pre-language-split) profile going stale as an intentional change, not a bug', () => {
    const legacy = profile({ templateLanguage: LEGACY_TEMPLATE_LANGUAGE })
    const reasons = stalenessReasons(legacy, baseKey, '2026-08-07T10:00:00Z')
    const joined = reasons.join(' ')
    expect(joined).toMatch(/sablon/i)
    expect(joined).toMatch(/nyelv/i)
    expect(joined).not.toBe('Az elicitációs sablon azóta módosult, így a profil egy már nem létező promptot ír le.')
  })

  it('treats a profile with no recorded templateLanguage the same way (older than even the sentinel)', () => {
    const legacy = profile({ templateLanguage: undefined })
    const reasons = stalenessReasons(legacy, baseKey, '2026-08-07T10:00:00Z')
    expect(reasons.join(' ')).toMatch(/nyelv/i)
  })

  it('keeps the plain generic wording for a FUTURE template edit unrelated to language', () => {
    // A profile already measured under the new, language-aware template (so it
    // carries a real 'hu'/'en' value) going stale later is a different event —
    // some other part of the template changed, and the language explanation
    // would be actively misleading here.
    const modern = profile({ templateLanguage: 'hu' })
    const reasons = stalenessReasons(modern, baseKey, '2026-08-07T10:00:00Z')
    expect(reasons.join(' ')).toBe('Az elicitációs sablon azóta módosult, így a profil egy már nem létező promptot ír le.')
  })

  it('does not mention the template at all when the hash matches', () => {
    const same = profile({ promptTemplateHash: baseKey.promptTemplateHash, templateLanguage: LEGACY_TEMPLATE_LANGUAGE })
    const reasons = stalenessReasons(same, baseKey, '2026-08-07T10:00:00Z')
    expect(reasons.join(' ')).not.toMatch(/sablon/i)
  })
})
