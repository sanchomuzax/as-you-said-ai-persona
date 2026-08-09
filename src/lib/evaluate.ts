import { POSITION_SHIFT_MIN_SAMPLE, type RunResults } from './results.js'
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
    /**
     * True when the run's OWN config carries `calibration: true` (issue #35;
     * read via `isCalibrationRun` in src/model-profiles.ts — never re-derived
     * here from the run name or from "this run happens to have zero
     * personas", since an ordinary research run can legitimately have zero
     * personas too). A calibration run has NO persona rows at all: every
     * response is the control arm. The persona-research prompt below asks
     * the judge to discuss persona differences, persona effect vs. control,
     * and stereotyping risk — all meaningless (and actively misleading, see
     * issue #35) when there is no persona to begin with. `buildCalibrationEvaluationPrompt`
     * reuses the SAME per-question line rendering (via `buildQuestionLines`)
     * but replaces the framing entirely.
     */
    calibration?: boolean
  } = {}
): string {
  const providers = context.providers ?? []
  if (context.calibration) {
    return buildCalibrationEvaluationPrompt(runName, results, providers)
  }
  const calibrationSection = buildCalibrationSection(context.profile ?? null)
  const providerNote = buildProviderNote(providers)
  const lines = buildQuestionLines(results)

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

/**
 * Several providers for one model id means several implementations answered:
 * part of the run-to-run variation is routing, not the persona or the seed.
 * Shared by both the persona-research and the calibration prompt (issue #35)
 * — the observation is about the model's serving stack, not about personas,
 * so it applies identically to a persona-free run.
 */
function buildProviderNote(providers: { provider: string; count: number }[]): string {
  return providers.length > 1
    ? `\n- FIGYELEM: ezt a futtatást ${providers.length} különböző szolgáltató szolgálta ki ugyanazzal a modell-azonosítóval (${providers
        .map((p) => `${p.provider}: ${p.count}`)
        .join(', ')}). A szolgáltatók eltérő kvantálással futtatják a modellt, ezért az ismétlési stabilitás (RS) romlásának egy része ROUTINGBÓL ered, nem a perszónából vagy a seedből — ezt az értelmezésnél kötelező jelezned.`
    : ''
}

/**
 * The per-question data lines, shared verbatim by both the persona-research
 * and the calibration prompt (issue #35). For a calibration run every
 * question falls through the `aggregatedResponseCount === 0` + `q.baseline`
 * branch below (issue #32 gave the control arm its own named group there
 * already) — there is nothing calibration-specific to add to this part of
 * the text, only to the framing AROUND it, which each caller supplies.
 */
function buildQuestionLines(results: RunResults): string[] {
  return results.questions.map((q) => {
    const multi = q.elicitationMode === 'multi_choice'
    const legacyNote =
      q.legacyElicitationCount > 0
        ? `\n  FIGYELEM: ${q.legacyElicitationCount} válasz régi, hibás elicitationnal készült, ezért ki van hagyva az aggregátumból.`
        : ''
    // Separate from legacyNote on purpose (mirrors the separate
    // legacyElicitationBaselineCount counter in results.ts, issue #40 review
    // MEDIUM): legacyNote's wording names "az aggregátumból" without saying
    // which one — fine when it fires for a persona-side drop (the persona
    // aggregate is the only one in scope there), but wrong if reused for a
    // control-arm drop, since "Kontroll — perszóna nélkül" / "KONTROLL-KAR" is
    // a DIFFERENT number from the persona aggregate. Named explicitly instead.
    const legacyBaselineNote =
      (q.legacyElicitationBaselineCount ?? 0) > 0
        ? `\n  FIGYELEM: ${q.legacyElicitationBaselineCount} kontroll-kar válasz régi, hibás elicitationnal készült, ezért ki van hagyva a kontroll-kar átlagából.`
        : ''
    const positionShiftLine = buildPositionShiftLine(q)

    // Zero usable responses must never be printed as zero percentages: the judge
    // would read a measured "nobody picked this" where nothing was measured.
    if (q.aggregatedResponseCount === 0) {
      // Issue #32: a calibration (or any control-arm-only) run has NO persona
      // rows at all, so aggregatedResponseCount is legitimately 0 — but the
      // control arm itself DID answer, and that must never read as "no data".
      // It gets its own named group here, never folded into a persona result
      // and never silently dropped.
      if (q.baseline) {
        const baselineDist = q.baseline
          .map((p, i) => `${q.options[i]}: ${(p * 100).toFixed(1)}%`)
          .join(', ')
        // Since issue #40, PC/RS ARE computed for a baseline-only question (grouped
        // by the control arm's own seed/rotation) — but this branch never printed
        // them, even though buildCalibrationEvaluationPrompt unconditionally tells
        // the judge that PC < 0.7 makes a question's result mandatory-unreliable.
        // Labeled "Kontroll-kar", not the bare "PC"/"RS" the persona branch below
        // uses, so it reads as the control arm's own stability, not a persona's.
        return `Kérdés: ${q.text}
  Nincs perszónás válasz ehhez a kérdéshez (a futtatásnak nincs perszóna-kara, vagy egyik sem adott értékelhető választ).
  Kontroll — perszóna nélkül: ${baselineDist}${legacyNote}${legacyBaselineNote}
  Invalid: ${q.invalidCount}/${q.totalResponses}, Abstain: ${q.abstainCount}/${q.totalResponses}
  Kontroll-kar pozíció-konzisztencia (PC): ${fmt(q.positionConsistency)}, kontroll-kar ismétlési stabilitás (RS): ${fmt(q.repetitionStability)}${positionShiftLine}`
      }
      // The control arm can be entirely dropped by the elicitation-mode filter
      // (issue #40 review MEDIUM) while still having produced legacy rows —
      // that is exactly the case legacyBaselineNote exists to surface, so it
      // must reach the text even in the no-data-at-all branch (issue #40
      // review HIGH), not only the two branches above/below that have SOME
      // surviving side.
      return `Kérdés: ${q.text}
  Nincs értékelhető válasz ehhez a kérdéshez.${legacyNote}${legacyBaselineNote}
  Invalid: ${q.invalidCount}/${q.totalResponses}, Abstain: ${q.abstainCount}/${q.totalResponses}${positionShiftLine}`
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
          .join(', ')}${legacyBaselineNote}\n  Perszóna-hatás (JS-divergencia a kontrolltól): ${Object.values(q.byPersona)
          .map((p) => `${p.name}: ${p.baselineDivergence === null ? 'n/a' : p.baselineDivergence.toFixed(3)}${divergenceSuffix(p.movesModel)}`)
          .join('; ')}`
      // legacyBaselineNote must still reach the judge when the elicitation-mode
      // filter dropped EVERY control-arm row for this question (q.baseline is
      // null then), even though the persona side still has data — otherwise the
      // judge reads "no control arm for this question" instead of "control arm
      // data was dropped" (issue #40 review HIGH). legacyBaselineNote already
      // starts with its own leading newline, so it stands in for the whole line.
      : legacyBaselineNote
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
  ${stabilityLabel}: ${fmt(q.positionConsistency)}, Ismétlési stabilitás (RS): ${fmt(q.repetitionStability)}${positionShiftLine}`
  })
}

function buildPositionShiftLine(question: RunResults['questions'][number]): string {
  if (question.elicitationMode !== 'single_choice') return ''
  const sampleSize = question.positionShiftSampleSize
  const shift = question.positionShift
  if (shift === null) {
    return `\n  Pozíció-eltolódás: nem elég adat (${sampleSize}/${POSITION_SHIFT_MIN_SAMPLE} értékelhető cella); ez nem nulla eltolódás.`
  }

  const direction = Math.abs(shift) < 0.005 ? 'nincs irányeltolódás' : shift < 0 ? 'primacy' : 'recency'
  const signedValue = shift > 0 ? `+${shift.toFixed(2)}` : shift.toFixed(2)
  const tier = question.metadata?.['_tier']
  if (tier === 'gyenge') {
    const observed = direction === 'recency'
      ? 'a recency-jelzés összhangban van a csapda elvárásával'
      : direction === 'primacy'
        ? 'a primacy-jelzés nem támasztja alá a csapdát'
        : 'az iránysemleges jelzés nem dönti el, hogy a csapda megfelel-e az elvárásnak'
    return `\n  Pozíció-eltolódás: ${direction} ${signedValue} (n=${sampleSize}). Pollyanna-csapda (_tier: gyenge): ${observed}; a primacy-jelzés nem támasztja alá, hogy ez csapda. Ez diagnosztikai jel, nem automatikus termékminősítés.`
  }
  if (tier === 'jó') {
    const observed = direction === 'primacy'
      ? 'a primacy-jelzés összhangban van a jó kontroll elvárásával'
      : direction === 'recency'
        ? 'a recency-jelzés nem támasztja alá a jó kontroll elvárását'
        : 'az iránysemleges jelzés nem dönti el a jó kontroll megfelelőségét'
    return `\n  Pozíció-eltolódás: ${direction} ${signedValue} (n=${sampleSize}). Pollyanna-kontroll (_tier: jó): ${observed}. Ez diagnosztikai jel, nem automatikus termékminősítés.`
  }
  return `\n  Pozíció-eltolódás: ${direction} ${signedValue} (n=${sampleSize}). Diagnosztikai jel, nem automatikus termékminősítés.`
}

/**
 * The calibration-run judge prompt (issue #35). A calibration run has NO
 * persona rows at all — every response is the control arm — so this is a
 * SEPARATE prompt, not a flag threaded through the persona-research one:
 * every persona-shaped instruction (persona differences, persona effect vs.
 * control, stereotyping caveat, "no calibration profile exists for this
 * model") is either meaningless or actively misleading here, per the
 * project's own reporter-visible incident (issue #35's linked run).
 *
 * What this run DOES measure — and what the judge is asked to describe
 * instead — is the model's own default behaviour: where it places itself,
 * how position-sensitive it is (PC/RS), and — treated as a first-class
 * finding, not a data gap — where it declines to answer at all. A model
 * that abstains on self-report demographic items when no persona was given
 * is behaving CORRECTLY (it is not confabulating a life for itself); the
 * project's own probe run measured a 28.8% abstain rate concentrated there
 * (issue #35), and a judge unaware of this distinction would misread that
 * as a quality problem with the run.
 */
function buildCalibrationEvaluationPrompt(
  runName: string,
  results: RunResults,
  providers: { provider: string; count: number }[]
): string {
  const providerNote = buildProviderNote(providers)
  const lines = buildQuestionLines(results)

  return `Egy modell-kalibrációs próbafutás ("${runName}") lefutott eredményeit kell kiértékelned kutatói szemmel, magyarul.

Ez a futás SZÁNDÉKOSAN nem tartalmaz perszónákat: minden válasz a kontroll-kar, vagyis azt méri, mit válaszol a modell alapból, amikor senki nem mondja meg neki, kinek a bőrébe bújjon (docs/MODEL-CALIBRATION.md). A futás célja maga a kalibráció: ebből az adatból — ha a minősége megfelelő — modell-profil rögzíthető, amihez a JÖVŐBENI perszónás futtatások eredményét viszonyítani lehet majd.

FONTOS SZABÁLYOK:
- Légy kritikus és tárgyilagos. NE dicsérd az eredményeket és NE adj udvariassági pozitív értékelést — a túlzó pozitivitás (Pollyanna-torzítás) ismert hibád, kerüld tudatosan.
- Kizárólag az alábbi, kódból számolt adatokra támaszkodj; új számokat ne találj ki.
- Ahol a pozíció-konzisztencia (PC) 0.7 alatt van, ott az adott kérdés eredményét KÖTELEZŐ megbízhatatlannak jelölnöd (a válasz a felsorolás sorrendjétől függött) — ez itt a modell SAJÁT pozíció-torzítását méri, nem egy perszónáét.
- TILOS bármilyen állítást tenni a szereplők (perszónák) egymáshoz viszonyított eltéréséről vagy perszóna-hatásról: ebben a futásban EGYETLEN perszóna sincs, minden válasz a kontroll-kar, tehát az ilyen jellegű csoport-összehasonlítás témája fel sem merülhet. Amit itt mérsz, a modell SAJÁT alapértelmezése — sose írd le perszóna-összehasonlításként.
- Az abstain itt KITÜNTETETT jelentőségű, és ALAPESETBEN NEM hiba: ha a tartózkodás önkép-jellegű, demográfiai kérdéseken (pl. kor, lakóhely, végzettség, anyagi helyzet) koncentrálódik, azt EREDMÉNYKÉNT mondd ki — a modell helyesen nem konfabulál demográfiát saját magának, amikor nincs kire vonatkoztatnia a választ. Csak akkor jelezd hiányosságként, ha a tartózkodás egyenletesen szóródik a kérdések között, vagy olyan kérdéseken is megjelenik, amelyek nem önkép-jellegűek.
${providerNote}${
    results.duplicateResponseCount > 0
      ? `\n- FIGYELEM: ${results.duplicateResponseCount} válasz ugyanazt a cellát ismételte meg (adatgyűjtési anomália). Az aggregátum cellánként egy mérést használ, de a gyűjtés nem volt tiszta — ezt az értelmezésnél jelezd.`
      : ''
  }
- A többválaszos kérdések számai opciónkénti FÜGGETLEN támogatottságok: ezeket tilos egyválaszos kérdések eloszlásaival közvetlenül összehasonlítani, és nem összegződnek 100%-ra. Ott a PC/RS a kiválasztott opció-HALMAZOK átfedését méri (nem egyetlen topválasz egyezését), tehát szigorúbb mutató — ezt vedd figyelembe az értelmezésnél.
- Ahol az adat "nincs értékelhető válasz", ott TILOS bármilyen tartalmi állítást tenni a kérdésről; csak a hiányt nevezd meg.

KALIBRÁCIÓS KONTEXTUS:
- Ehhez a futáshoz nincs — és a jellegéből adódóan nem is kell hogy legyen — korábbi kalibrációs profil, amihez viszonyítani kellene: ez a futás MAGA a leendő profil forrása, nem egy profilhoz mért eredmény. Ezt NE írd le hiányosságként.
- Ha az adatok minősége megfelelő (elegendő értékelhető cella, nem túl magas invalid-ráta, elfogadható PC/RS a nem-önkép kérdéseken), mondd ki explicit: "Ebből a futásból rögzíthető a profil."

ADATOK:
Összes válasz: ${results.totalResponses}, invalid-ráta: ${(results.invalidRate * 100).toFixed(1)}%, abstain-ráta: ${(results.abstainRate * 100).toFixed(1)}%

${lines.join('\n\n')}

KIMENET (magyarul, tömören, max ~500 szó):
1. Kalibrációs kontextus: mondd ki, hogy ez egy perszóna nélküli kalibrációs futás, aminek nincs — és nem is kell hogy legyen — korábbi profilja; és hogy az adatok minősége alapján rögzíthető-e belőle profil.
2. A modell alapértelmezett válaszadói profilja kérdésenként: hova helyezi el magát, milyen az érték-/bizalmi mintázata — csak ahol az adat megbízható.
3. Megbízhatósági figyelmeztetések: alacsony PC/RS (a modell saját pozíció-érzékenysége, nem perszónáé), magas invalid-ráta.
4. Abstain-mintázat: hol tartózkodott a modell, és — ha az önkép-jellegű, demográfiai kérdéseken koncentrálódik — miért EREDMÉNY ez, nem hiba.
5. Zárás: ez a modell alapértelmezett viselkedésének mérése, nem emberi minta; önmagában nem helyettesíti a humán validációt (TSTR-elv).`
}

function fmt(v: number | null): string {
  return v === null ? 'n/a' : v.toFixed(2)
}

/**
 * Qualifier for a persona's printed divergence number (issue #40 review
 * CRITICAL). `movesModel === false` is a genuinely DECIDED result — the
 * control arm's own noise floor was measured, and the divergence sat inside
 * it. `movesModel === null` here (only reachable when a real divergence was
 * already printed, i.e. a control arm exists) means the opposite: the noise
 * floor could NOT be measured — fewer than 2 surviving control-arm
 * seed-groups — so the judge must be told the number is real but
 * uninterpretable, never read as "within noise" (a different, false claim)
 * and never as an unqualified "moved the model".
 */
function divergenceSuffix(movesModel: boolean | null): string {
  if (movesModel === false) return ' (a zajszinten belül)'
  if (movesModel === null) return ' (nem eldönthető — kevés kontroll-adat)'
  return ''
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
