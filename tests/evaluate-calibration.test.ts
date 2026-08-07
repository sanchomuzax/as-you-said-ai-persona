import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '../src/db.js'
import { computeRunResults } from '../src/lib/results.js'
import { buildEvaluationPrompt } from '../src/lib/evaluate.js'

/**
 * Issue #35: a calibration run (`config_json.calibration === true`) has NO
 * personas at all — every response is a control-arm row (`persona_id IS
 * NULL`, `condition = 'baseline'`). Reusing the persona-research judge
 * prompt on it produces a meaningless report: it discusses "persona
 * differences" and "no calibration profile" for the very run whose PURPOSE
 * is to create that profile (docs/MODEL-CALIBRATION.md).
 *
 * This suite locks in:
 *  - the calibration-specific framing (no persona-effect/stereotyping talk,
 *    explicit "this measures the model's own default" framing, the "missing
 *    profile" warning replaced by "this run can become the profile", and
 *    abstention on self-report items read as a finding);
 *  - that the ORDINARY persona-research prompt is byte-for-byte unchanged
 *    when `calibration` is not set (golden text captured from the prompt
 *    BEFORE this fix, per the task's "keep the existing prompt unchanged"
 *    requirement).
 */

let db: Db
let runId: string
let qid: string

function insertCalibrationResponse(opts: {
  questionId: string
  dist?: Record<string, number> | null
  answer?: string | null
  abstained?: boolean
  seed?: number
  rotation?: number[]
}): void {
  db.prepare(
    `INSERT INTO responses (id, run_id, persona_id, question_id, model_requested, temperature, seed,
       permutation_json, prompt_rendered, raw_response, parsed_distribution_json, parsed_answer, is_valid, abstained, condition)
     VALUES (?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,'baseline')`
  ).run(
    randomUUID(), runId, opts.questionId, 'm', 1.0, opts.seed ?? 0,
    JSON.stringify(opts.rotation ?? [0, 1]), 'p', 'r',
    opts.abstained ? null : JSON.stringify(opts.dist ?? { '0': 0.8, '1': 0.2 }),
    opts.abstained ? null : (opts.answer ?? '0'),
    1, opts.abstained ? 1 : 0
  )
}

beforeEach(() => {
  db = createDb(':memory:')
  const questionnaireId = randomUUID()
  qid = randomUUID()
  runId = randomUUID()
  db.prepare('INSERT INTO questionnaires (id, name) VALUES (?,?)').run(questionnaireId, 'Q')
  db.prepare('INSERT INTO questions (id, questionnaire_id, ord, text, options_json) VALUES (?,?,0,?,?)').run(
    qid, questionnaireId, 'Mennyire bízol az intézményekben?', JSON.stringify(['Egyáltalán nem', 'Nagyon'])
  )
  db.prepare('INSERT INTO runs (id, questionnaire_id, name, config_json) VALUES (?,?,?,?)').run(
    runId, questionnaireId, 'Kalibráció — m',
    JSON.stringify({ model: 'm', temperature: 1, seeds: [0, 1], calibration: true })
  )
})

describe('buildEvaluationPrompt — calibration framing (issue #35)', () => {
  it('never claims persona differences, persona effect, or stereotyping for a run with no personas', () => {
    insertCalibrationResponse({ questionId: qid, dist: { '0': 0.2, '1': 0.8 } })
    const prompt = buildEvaluationPrompt('Kalibráció — m', computeRunResults(db, runId), { calibration: true })
    expect(prompt).not.toMatch(/perszónák közti/i)
    expect(prompt).not.toMatch(/spurious.split/i)
    expect(prompt).not.toMatch(/sztereotip/i)
    expect(prompt).not.toContain('Perszónánkénti topválasz')
  })

  it("frames the run explicitly as measuring the model's own default, not a persona study", () => {
    insertCalibrationResponse({ questionId: qid, dist: { '0': 0.2, '1': 0.8 } })
    const prompt = buildEvaluationPrompt('Kalibráció — m', computeRunResults(db, runId), { calibration: true })
    // Anchored to the OPENING sentence specifically (not just "the word
    // MODELL-KALIBRÁCIÓ appears somewhere") — the pre-existing per-question
    // calibration-profile section header would otherwise make this pass
    // even with no calibration-run framing at all (verified: this assertion
    // alone was a false green against the unmodified code).
    const intro = prompt.slice(0, prompt.indexOf('FONTOS SZABÁLYOK'))
    expect(intro).toMatch(/modell-kalibráci/i)
    expect(intro).toMatch(/senki nem mondja meg neki|nem tartalmaz perszón/i)
  })

  it('does not render the ordinary "missing calibration profile" warning', () => {
    insertCalibrationResponse({ questionId: qid, dist: { '0': 0.2, '1': 0.8 } })
    const prompt = buildEvaluationPrompt('Kalibráció — m', computeRunResults(db, runId), { calibration: true })
    expect(prompt).not.toContain('KÖTELEZŐ kimondanod: ehhez a modellhez nincs mért alap-pozitivitás')
  })

  it('tells the judge the next step is recording the profile from this run, once quality allows it', () => {
    insertCalibrationResponse({ questionId: qid, dist: { '0': 0.2, '1': 0.8 } })
    const prompt = buildEvaluationPrompt('Kalibráció — m', computeRunResults(db, runId), { calibration: true })
    expect(prompt).toMatch(/ebből a futásból rögzíthető a profil/i)
  })

  it('instructs the judge to read abstention concentrated on self-report demographic questions as a finding, not a defect', () => {
    const demoQid = randomUUID()
    db.prepare('INSERT INTO questions (id, questionnaire_id, ord, text, options_json) VALUES (?,?,1,?,?)').run(
      demoQid,
      (db.prepare('SELECT questionnaire_id q FROM runs WHERE id = ?').get(runId) as { q: string }).q,
      'Hány éves vagy?', JSON.stringify(['18-30', '31-50', '51+'])
    )
    // demographic self-report question: the model abstains instead of inventing a persona for itself
    insertCalibrationResponse({ questionId: demoQid, abstained: true, seed: 0 })
    insertCalibrationResponse({ questionId: demoQid, abstained: true, seed: 1 })
    // ordinary attitude question: answered normally
    insertCalibrationResponse({ questionId: qid, dist: { '0': 0.2, '1': 0.8 }, seed: 0 })
    const prompt = buildEvaluationPrompt('Kalibráció — m', computeRunResults(db, runId), { calibration: true })
    expect(prompt).toMatch(/tartózkodás/i)
    expect(prompt).toMatch(/nem hiba|nem defekt/i)
    expect(prompt).toMatch(/önkép|demográfi/i)
  })
})

describe('buildEvaluationPrompt — ordinary persona-research prompt is unchanged (issue #35)', () => {
  it('produces byte-for-byte the same prompt as before this fix, when calibration is not set', () => {
    const questionnaireId = randomUUID()
    const q2 = randomUUID()
    const p1 = randomUUID()
    const rid = randomUUID()
    db.prepare('INSERT INTO questionnaires (id, name) VALUES (?,?)').run(questionnaireId, 'Q')
    db.prepare('INSERT INTO questions (id, questionnaire_id, ord, text, options_json) VALUES (?,?,0,?,?)').run(
      q2, questionnaireId, 'Trust?', JSON.stringify(['Yes', 'No'])
    )
    db.prepare('INSERT INTO personas (id, name, demographics_json) VALUES (?,?,?)').run(p1, 'P1', '{}')
    db.prepare('INSERT INTO runs (id, questionnaire_id, name, config_json) VALUES (?,?,?,?)').run(
      rid, questionnaireId, 'R', JSON.stringify({ model: 'm', temperature: 1, seeds: [0, 1] })
    )
    db.prepare('INSERT INTO run_personas (run_id, persona_id) VALUES (?,?)').run(rid, p1)
    db.prepare(
      `INSERT INTO responses (id, run_id, persona_id, question_id, model_requested, temperature, seed,
         permutation_json, prompt_rendered, raw_response, parsed_distribution_json, parsed_answer, is_valid, abstained)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      randomUUID(), rid, p1, q2, 'm', 1.0, 0,
      JSON.stringify([0, 1]), 'p', 'r',
      JSON.stringify({ '0': 0.9, '1': 0.1 }), '0', 1, 0
    )
    const prompt = buildEvaluationPrompt('R', computeRunResults(db, rid))
    expect(prompt).toBe(GOLDEN_PERSONA_PROMPT)
  })
})

// Captured verbatim from buildEvaluationPrompt's output BEFORE issue #35's fix
// (same fixture as above). Any change to the ordinary persona-research prompt
// wording must be a deliberate, reviewed edit — not a side effect of adding
// the calibration branch.
const GOLDEN_PERSONA_PROMPT =
  'Egy szintetikus AI-perszóna kérdőíves kutatás ("R") lefutott eredményeit kell kiértékelned kutatói szemmel, magyarul.\n\nFONTOS SZABÁLYOK:\n- Légy kritikus és tárgyilagos. NE dicsérd az eredményeket és NE adj udvariassági pozitív értékelést — a túlzó pozitivitás (Pollyanna-torzítás) ismert hibád, kerüld tudatosan.\n- Kizárólag az alábbi, kódból számolt adatokra támaszkodj; új számokat ne találj ki.\n- Ahol a pozíció-konzisztencia (PC) 0.7 alatt van, ott az adott kérdés eredményét KÖTELEZŐ megbízhatatlannak jelölnöd (a válasz a felsorolás sorrendjétől függött).\n- A perszónák közti éles különbségeket fenntartással kezeld: az LLM-ek a csoportkülönbségeket tipikusan 2-4x felnagyítják (spurious split kockázat).\n- Ahol van KONTROLL-KAR, ott a perszónás eredményt KÖTELEZŐ ahhoz KÉPEST értelmezni: ha egy perszóna divergenciája a zajszinten belül van, mondd ki, hogy ott a perszóna nem térítette el a modellt a saját alapértelmezésétől — az eredmény a modell tulajdonsága, nem a perszónáé.\n- Az abstain nem hiba, hanem bizonyítékhézag: jelezd, mely témákban nem volt a perszónáknak megalapozott válasza.\n\n- A többválaszos kérdések számai opciónkénti FÜGGETLEN támogatottságok: ezeket tilos egyválaszos kérdések eloszlásaival közvetlenül összehasonlítani, és nem összegződnek 100%-ra. Ott a PC/RS a kiválasztott opció-HALMAZOK átfedését méri (nem egyetlen topválasz egyezését), tehát szigorúbb mutató — ezt vedd figyelembe az értelmezésnél.\n- Ahol az adat "nincs értékelhető válasz", ott TILOS bármilyen tartalmi állítást tenni a kérdésről; csak a hiányt nevezd meg.\n\nMODELL-KALIBRÁCIÓ:\n- KÖTELEZŐ kimondanod: ehhez a modellhez nincs mért alap-pozitivitás és pozíció-torzítás, amihez az alábbi eredményeket viszonyítani lehetne (nincs kalibrációs profil). Emiatt a perszóna-eredményeket csak egymáshoz vagy — ha van — a KONTROLL-KARHOZ képest lehet olvasni, a modell szélesebb alapértelmezéséhez képest nem.\n- A perszóna-eredményt — ahol van KONTROLL-KAR — AHHOZ KÉPEST értelmezd: ha egy perszóna divergenciája a zajszinten belül van, mondd ki, hogy ott a perszóna NEM TÉRÍTETTE EL a modellt a saját alapértelmezésétől.\n- Sztereotipizálási fenntartás: a perszónák közti különbségek — a KONTROLL-KARTÓL mért eltéréshez hasonlóan — FELSŐ KORLÁTOT jelentenek, nem megállapítást; a valódi (nem véletlen ingadozásból eredő) csoportkülönbséghez humán adat kellene, ami egyelőre nincs.\n\nADATOK:\nÖsszes válasz: 1, invalid-ráta: 0.0%, abstain-ráta: 0.0%\n\nKérdés: Trust?\n  Aggregált eloszlás: Yes: 90.0%, No: 10.0%\n  Perszónánkénti topválasz: P1→Yes\n  Invalid: 0/1, Abstain: 0/1\n  Pozíció-konzisztencia (PC): 1.00, Ismétlési stabilitás (RS): 1.00\n\nKIMENET (magyarul, tömören, max ~500 szó):\n1. Kalibrációs kontextus: mondd ki explicit, hogy ehhez a futtatáshoz volt-e érvényes kalibrációs profil, elavult volt-e (és miért), vagy nem volt egyáltalán — ez a lenti pontok értelmezését korlátozza, nem csak háttérinformáció.\n2. Fő mintázatok kérdésenként (csak ahol az adat megbízható).\n3. Megbízhatósági figyelmeztetések (alacsony PC/RS, magas invalid, abstain-témák).\n4. Perszónák közti eltérések — a spurious-split fenntartással.\n5. Zárás: kötelező TSTR-emlékeztető (a szintetikus eredmény hipotézis, humán validáció nélkül döntésre nem használható).'
