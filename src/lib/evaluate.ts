import type { RunResults } from './results.js'

/**
 * Builds the Hungarian LLM-as-judge prompt for summarizing a finished run.
 * Anti-bias measures (per the judge-bias literature): the judge only INTERPRETS
 * metrics we computed in code (never produces numbers itself), is explicitly
 * instructed to be critical (anti-sycophancy/Pollyanna), must flag low
 * position-consistency questions as unreliable, and must close with the TSTR
 * caveat that synthetic results are hypotheses requiring human validation.
 */
export function buildEvaluationPrompt(runName: string, results: RunResults): string {
  const lines = results.questions.map((q) => {
    const dist = q.aggregated
      .map((p, i) => `${q.options[i]}: ${(p * 100).toFixed(1)}%`)
      .join(', ')
    const personaTops = Object.values(q.byPersona)
      .map((p) => {
        const top = p.distribution.indexOf(Math.max(...p.distribution))
        return `${p.name}→${q.options[top] ?? 'n/a'}`
      })
      .join('; ')
    return `Kérdés: ${q.text}
  Aggregált eloszlás: ${dist}
  Perszónánkénti topválasz: ${personaTops}
  Invalid: ${q.invalidCount}/${q.totalResponses}, Abstain: ${q.abstainCount}/${q.totalResponses}
  Pozíció-konzisztencia (PC): ${fmt(q.positionConsistency)}, Ismétlési stabilitás (RS): ${fmt(q.repetitionStability)}`
  })

  return `Egy szintetikus AI-perszóna kérdőíves kutatás ("${runName}") lefutott eredményeit kell kiértékelned kutatói szemmel, magyarul.

FONTOS SZABÁLYOK:
- Légy kritikus és tárgyilagos. NE dicsérd az eredményeket és NE adj udvariassági pozitív értékelést — a túlzó pozitivitás (Pollyanna-torzítás) ismert hibád, kerüld tudatosan.
- Kizárólag az alábbi, kódból számolt adatokra támaszkodj; új számokat ne találj ki.
- Ahol a pozíció-konzisztencia (PC) 0.7 alatt van, ott az adott kérdés eredményét KÖTELEZŐ megbízhatatlannak jelölnöd (a válasz a felsorolás sorrendjétől függött).
- A perszónák közti éles különbségeket fenntartással kezeld: az LLM-ek a csoportkülönbségeket tipikusan 2-4x felnagyítják (spurious split kockázat).
- Az abstain nem hiba, hanem bizonyítékhézag: jelezd, mely témákban nem volt a perszónáknak megalapozott válasza.

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
