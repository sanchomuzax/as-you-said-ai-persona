import type { RunResults } from './results.js'
import type { StoredProfile, ProfileStatus } from './profile.js'

/**
 * Builds the Hungarian LLM-as-judge prompt for summarizing a finished run.
 * Anti-bias measures (per the judge-bias literature): the judge only INTERPRETS
 * metrics we computed in code (never produces numbers itself), is explicitly
 * instructed to be critical (anti-sycophancy/Pollyanna), must flag low
 * position-consistency questions as unreliable, and must close with the TSTR
 * caveat that synthetic results are hypotheses requiring human validation.
 */
export function buildEvaluationPrompt(
  runName: string,
  results: RunResults,
  context: {
    providers?: { provider: string; count: number }[]
    /**
     * The model-calibration profile active for THIS RUN (issue #17 M3,
     * docs/MODEL-CALIBRATION.md §4 — findProfileForRun in src/model-profiles.ts
     * judges the profile against the stack this run's own responses were
     * served by, never "today's" global stack; see that function's docstring
     * for why, issue #17 M3 review HIGH 1). `undefined` (the default, for
     * callers that predate this milestone) and `null` (looked up, found
     * nothing) are both rendered as the same explicit "no profile" section
     * below — a missing profile must never be a silently missing section,
     * because a judge that says nothing about calibration will read persona
     * numbers as absolute.
     */
    profile?: {
      profile: StoredProfile
      status: ProfileStatus
      /** Concrete reasons the profile is stale FOR THIS RUN (empty when valid). */
      reasons?: string[]
      /** The stack this run's OWN responses were actually served by. */
      runStack?: { modelVersion: string | null; provider: string | null }
    } | null
  } = {}
): string {
  const providers = context.providers ?? []
  const calibrationSection = buildCalibrationSection(context.profile ?? null)
  // Several providers for one model id means several implementations answered:
  // part of the run-to-run variation is routing, not the persona or the seed.
  const providerNote =
    providers.length > 1
      ? `\n- FIGYELEM: ezt a futtatást ${providers.length} különböző szolgáltató szolgálta ki ugyanazzal a modell-azonosítóval (${providers
          .map((p) => `${p.provider}: ${p.count}`)
          .join(', ')}). A szolgáltatók eltérő kvantálással futtatják a modellt, ezért az ismétlési stabilitás (RS) romlásának egy része ROUTINGBÓL ered, nem a perszónából vagy a seedből — ezt az értelmezésnél kötelező jelezned.`
      : ''
  const lines = results.questions.map((q) => {
    const multi = q.elicitationMode === 'multi_choice'
    const legacyNote =
      q.legacyElicitationCount > 0
        ? `\n  FIGYELEM: ${q.legacyElicitationCount} válasz régi, hibás elicitationnal készült, ezért ki van hagyva az aggregátumból.`
        : ''

    // Zero usable responses must never be printed as zero percentages: the judge
    // would read a measured "nobody picked this" where nothing was measured.
    if (q.aggregatedResponseCount === 0) {
      return `Kérdés: ${q.text}
  Nincs értékelhető válasz ehhez a kérdéshez.${legacyNote}
  Invalid: ${q.invalidCount}/${q.totalResponses}, Abstain: ${q.abstainCount}/${q.totalResponses}`
    }

    const dist = q.aggregated
      .map((p, i) => `${q.options[i]}: ${(p * 100).toFixed(1)}%`)
      .join(', ')
    const distLabel = multi
      ? 'Opciónkénti támogatottság (TÖBBVÁLASZOS kérdés: független valószínűségek, nem összegződnek 100%-ra)'
      : 'Aggregált eloszlás'
    const baselineLine = q.baseline
      ? `\n  KONTROLL-KAR (perszóna nélküli válasz ugyanerre a kérdésre): ${q.baseline
          .map((p, i) => `${q.options[i]}: ${(p * 100).toFixed(1)}%`)
          .join(', ')}\n  Perszóna-hatás (JS-divergencia a kontrolltól): ${Object.values(q.byPersona)
          .map((p) => `${p.name}: ${p.baselineDivergence === null ? 'n/a' : p.baselineDivergence.toFixed(3)}${p.movesModel === false ? ' (a zajszinten belül)' : ''}`)
          .join('; ')}`
      : ''
    const personaTops = Object.values(q.byPersona)
      .map((p) => {
        const max = Math.max(...p.distribution)
        if (!(max > 0)) return `${p.name}→nincs értékelhető válasz`
        return `${p.name}→${q.options[p.distribution.indexOf(max)] ?? 'n/a'}`
      })
      .join('; ')
    const stabilityLabel = multi
      ? 'Pozíció-konzisztencia (PC, halmaz-átfedés)'
      : 'Pozíció-konzisztencia (PC)'
    return `Kérdés: ${q.text}
  ${distLabel}: ${dist}${legacyNote}
  Perszónánkénti topválasz: ${personaTops}${baselineLine}
  Invalid: ${q.invalidCount}/${q.totalResponses}, Abstain: ${q.abstainCount}/${q.totalResponses}
  ${stabilityLabel}: ${fmt(q.positionConsistency)}, Ismétlési stabilitás (RS): ${fmt(q.repetitionStability)}`
  })

  return `Egy szintetikus AI-perszóna kérdőíves kutatás ("${runName}") lefutott eredményeit kell kiértékelned kutatói szemmel, magyarul.

FONTOS SZABÁLYOK:
- Légy kritikus és tárgyilagos. NE dicsérd az eredményeket és NE adj udvariassági pozitív értékelést — a túlzó pozitivitás (Pollyanna-torzítás) ismert hibád, kerüld tudatosan.
- Kizárólag az alábbi, kódból számolt adatokra támaszkodj; új számokat ne találj ki.
- Ahol a pozíció-konzisztencia (PC) 0.7 alatt van, ott az adott kérdés eredményét KÖTELEZŐ megbízhatatlannak jelölnöd (a válasz a felsorolás sorrendjétől függött).
- A perszónák közti éles különbségeket fenntartással kezeld: az LLM-ek a csoportkülönbségeket tipikusan 2-4x felnagyítják (spurious split kockázat).
- Ahol van KONTROLL-KAR, ott a perszónás eredményt KÖTELEZŐ ahhoz KÉPEST értelmezni: ha egy perszóna divergenciája a zajszinten belül van, mondd ki, hogy ott a perszóna nem térítette el a modellt a saját alapértelmezésétől — az eredmény a modell tulajdonsága, nem a perszónáé.
- Az abstain nem hiba, hanem bizonyítékhézag: jelezd, mely témákban nem volt a perszónáknak megalapozott válasza.
${providerNote}${
    results.duplicateResponseCount > 0
      ? `\n- FIGYELEM: ${results.duplicateResponseCount} válasz ugyanazt a cellát ismételte meg (adatgyűjtési anomália). Az aggregátum cellánként egy mérést használ, de a gyűjtés nem volt tiszta — ezt az értelmezésnél jelezd.`
      : ''
  }
- A többválaszos kérdések számai opciónkénti FÜGGETLEN támogatottságok: ezeket tilos egyválaszos kérdések eloszlásaival közvetlenül összehasonlítani, és nem összegződnek 100%-ra. Ott a PC/RS a kiválasztott opció-HALMAZOK átfedését méri (nem egyetlen topválasz egyezését), tehát szigorúbb mutató — ezt vedd figyelembe az értelmezésnél.
- Ahol az adat "nincs értékelhető válasz", ott TILOS bármilyen tartalmi állítást tenni a kérdésről; csak a hiányt nevezd meg.
${calibrationSection}

ADATOK:
Összes válasz: ${results.totalResponses}, invalid-ráta: ${(results.invalidRate * 100).toFixed(1)}%, abstain-ráta: ${(results.abstainRate * 100).toFixed(1)}%

${lines.join('\n\n')}

KIMENET (magyarul, tömören, max ~500 szó):
1. Kalibrációs kontextus: mondd ki explicit, hogy ehhez a futtatáshoz volt-e érvényes kalibrációs profil, elavult volt-e (és miért), vagy nem volt egyáltalán — ez a lenti pontok értelmezését korlátozza, nem csak háttérinformáció.
2. Fő mintázatok kérdésenként (csak ahol az adat megbízható).
3. Megbízhatósági figyelmeztetések (alacsony PC/RS, magas invalid, abstain-témák).
4. Perszónák közti eltérések — a spurious-split fenntartással.
5. Zárás: kötelező TSTR-emlékeztető (a szintetikus eredmény hipotézis, humán validáció nélkül döntésre nem használható).`
}

function fmt(v: number | null): string {
  return v === null ? 'n/a' : v.toFixed(2)
}

/**
 * Model-calibration section (issue #17 M3, docs/MODEL-CALIBRATION.md §4, and
 * the follow-up review of that milestone). Every number here comes from the
 * model_profiles registry (src/lib/profile.ts), computed from the model's own
 * persona-free responses — never from this run, and never invented by the
 * judge. A missing or stale profile is stated explicitly rather than the
 * section being omitted: silence here is exactly what would let the judge
 * read persona numbers as absolute, which is the failure mode this milestone
 * exists to prevent.
 *
 * The "no profile" instruction is deliberately AT LEAST as binding as the
 * "stale profile" one (review MED): missing calibration is the more serious
 * gap, not a lesser one, and must not read as an afterthought next to it.
 */
function buildCalibrationSection(
  context: {
    profile: StoredProfile
    status: ProfileStatus
    reasons?: string[]
    runStack?: { modelVersion: string | null; provider: string | null }
  } | null
): string {
  const caveat =
    'Sztereotipizálási fenntartás: a perszónák közti különbségek — a KONTROLL-KARTÓL mért eltéréshez hasonlóan — FELSŐ KORLÁTOT jelentenek, nem megállapítást; a valódi (nem véletlen ingadozásból eredő) csoportkülönbséghez humán adat kellene, ami egyelőre nincs.'
  // Restated HERE (not only relied on via the pre-existing, unconditional
  // KONTROLL-KAR bullet in FONTOS SZABÁLYOK) so this section is self-contained:
  // a reader — or a future edit that removes the other bullet — should not be
  // able to lose the instruction that matters most for reading calibration
  // context correctly (review false-green #1).
  const baselineInstruction =
    'A perszóna-eredményt — ahol van KONTROLL-KAR — AHHOZ KÉPEST értelmezd: ha egy perszóna divergenciája a zajszinten belül van, mondd ki, hogy ott a perszóna NEM TÉRÍTETTE EL a modellt a saját alapértelmezésétől.'

  if (!context) {
    return `
MODELL-KALIBRÁCIÓ:
- KÖTELEZŐ kimondanod: ehhez a modellhez nincs mért alap-pozitivitás és pozíció-torzítás, amihez az alábbi eredményeket viszonyítani lehetne (nincs kalibrációs profil). Emiatt a perszóna-eredményeket csak egymáshoz vagy — ha van — a KONTROLL-KARHOZ képest lehet olvasni, a modell szélesebb alapértelmezéséhez képest nem.
- ${baselineInstruction}
- ${caveat}`
  }

  // Defensive (issue #17 M3 review, HIGH 2): profile.metrics may be null or a
  // PARTIAL object — an older profile, or a future schema change (M4) that
  // makes every profile M2 ever wrote "partial" to this reader. A thrown error
  // here would silently kill the whole evaluation through the auto-eval path's
  // `.catch(() => undefined)` (src/server.ts) — no row, no log, no UI message.
  // Optional-chained all the way down PLUS a try/catch belt-and-suspenders: it
  // degrades to the "no profile" wording rather than ever taking the request down.
  try {
    const { profile, status } = context
    const reasons = context.reasons ?? []
    const runStack = context.runStack ?? { modelVersion: null, provider: null }
    const metrics = profile.metrics
    const offset = metrics?.positivityOffset ?? null
    const bias = metrics?.priorBias?.maxDeviation ?? null
    const cellCount = metrics?.provenance?.cellCount ?? null
    const offsetLine = offset === null ? 'nem mérhető (a próbában nincs irányított skála)' : offset.toFixed(3)
    const biasLine = bias === null ? 'nem mérhető' : bias.toFixed(3)

    // HIGH 1 (issue #17 M3 review): BOTH stacks, printed explicitly, so the
    // judge can see what is actually being compared — not just a verdict.
    // MINOR: measurement date + cell count, so a profile built from 8 cells
    // does not read exactly like one built from 300.
    const stackLines = `
- A profil mérési stackje: modellverzió ${profile.modelVersion}, szolgáltató ${profile.provider ?? 'nincs rögzítve'} (mérve: ${profile.createdAt}${cellCount === null ? '' : `, ${cellCount} cellából`}).
- E futtatás saját stackje (amivel ez a profil összevetve lett): modellverzió ${runStack.modelVersion ?? 'nem rögzített'}, szolgáltató ${runStack.provider ?? 'nincs rögzítve'}.`

    // MED (review): the ACTUAL, concrete reason(s) — computed by the same
    // stalenessReasons() the "Modellek" tab uses (src/model-profiles.ts) — not
    // a generic paragraph listing every possible reason regardless of which
    // one is true.
    const staleNote =
      status === 'stale'
        ? `\n- FIGYELEM: ez a profil ELAVULT erre a futtatásra nézve${
            reasons.length > 0 ? ` — ok(ok): ${reasons.join(' ')}` : ''
          } A fenti számok azt írják le, ami a profil mérésekor igaz volt; erre a futtatásra nem feltétlenül érvényesek — ezt KÖTELEZŐ jelezned, ugyanolyan nyomatékkal, mint egy hiányzó profilt.`
        : ''

    return `
MODELL-KALIBRÁCIÓ (profil státusza: ${status === 'stale' ? 'ELAVULT' : 'érvényes'}):${stackLines}
- ${baselineInstruction}
- A modell mért alap-pozitivitása (irányított, azaz ordinális/gyakorisági kérdéseken, MINDEN ilyen kérdésre azonos súllyal átlagolva; 0 = skálaközép, +0.5 = skálatető): ${offsetLine}. Ez NEM a tervezett termékértékelő csapdakérdés-torzítás közvetlen mérése — a próba egyelőre nem jelöli meg külön azokat a kérdéseket, ezért ez a mért pozitivitás-eltolás a Pollyanna-torzítás TÁGABB és GYENGÉBB közelítése, minden irányított skálára átlagolva. A kérdések azonos súllyal számítanak, ezért egy rövid (kétfokú) skála nagyobbat lendít az átlagon, mint egy ötfokú. Irányított/pozitív jellegű kérdéseknél az eredményt EHHEZ a mért pozitivitás-eltoláshoz KÉPEST, óvatosan értelmezd — nem önmagában, és nem célzottan mért csapdakérdés-torzításként.
- Pozíció-torzítás (legnagyobb eltérés az egyenletes aránytól, kiegyensúlyozott permutáció mellett): ${biasLine}.
- ${caveat}${staleNote}`
  } catch {
    return buildCalibrationSection(null)
  }
}
