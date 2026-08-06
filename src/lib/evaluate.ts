import type { RunResults } from './results.js'

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
  context: { providers?: { provider: string; count: number }[] } = {}
): string {
  const providers = context.providers ?? []
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

ADATOK:
Összes válasz: ${results.totalResponses}, invalid-ráta: ${(results.invalidRate * 100).toFixed(1)}%, abstain-ráta: ${(results.abstainRate * 100).toFixed(1)}%

${lines.join('\n\n')}

KIMENET (magyarul, tömören, max ~500 szó):
1. Fő mintázatok kérdésenként (csak ahol az adat megbízható).
2. Megbízhatósági figyelmeztetések (alacsony PC/RS, magas invalid, abstain-témák).
3. Perszónák közti eltérések — a spurious-split fenntartással.
4. Zárás: kötelező TSTR-emlékeztető (a szintetikus eredmény hipotézis, humán validáció nélkül döntésre nem használható).`
}

function fmt(v: number | null): string {
  return v === null ? 'n/a' : v.toFixed(2)
}
