# Model Calibration & Baseline Integration — Design

Status: design v1.0 (2026-08-06). Grounded in the research corpus: PriDe /
CalibraEval composite-bias calibration, the Δη² stereotyping index, the documented
+1.20 SD RLHF positivity offset, and the recommendation to run a persona-free
control arm inside every live experiment.

## 0. Purpose

Turn the default-persona probe (see `RESEARCH-DESIGN.md` and issue #14) from a
one-off experiment into a **standing calibration subsystem**: every model gets a
measured "model profile"; every research run gets a persona-free control arm; and
every evaluation interprets persona results *relative to* the model's measured
default — never as absolute truth.

## 1. Concepts

- **Probe**: the versioned calibration questionnaire (30 items: implicit
  self-image, WVS values, GSS trust/attitudes, BFI-10, Pollyanna trap, cognitive
  style). It carries the durable `is_calibration_probe` designation and is
  versioned like any questionnaire (lineage + version). The calibration UI offers
  designated probes by default. An ordinary questionnaire can still be launched
  explicitly through the API, but both the run and the resulting profile record
  `limited` interpretability and show a visible methodological warning.
- **Model profile**: the stored result of running the probe against one exact
  (model_version, provider, prompt-template, probe-version, language) combination.
- **Control arm**: persona-free cells fired inside a normal research run, one per
  (question × rotation × seed), recorded alongside persona cells.

## 2. Model profile registry

New table `model_profiles`:

```
model_profiles(id, model_requested, model_version, provider,
               probe_questionnaire_id,            -- exact probe version used
               prompt_template_hash,              -- hash of the elicitation template
               language,                          -- probe language (hu/en/…)
               run_ids_json,                      -- calibration runs behind this profile
               metrics_json,                      -- see below
               status,                            -- valid | stale | superseded
               created_at, valid_until)
```

`metrics_json` (all computed in code, never by an LLM):
- per-question default distribution (null-persona condition), name-only deltas;
- **prior-bias vector** (PriDe-style): per-position and per-label preference
  estimated from the balanced permutations — usable later as a correction divisor;
- **Pollyanna offset**: mean positive shift on the product-evaluation trap items;
- invalid rate, abstain rate, PC, RS, and the seed-noise floor;
- profile provenance: dates, cell counts, token cost.

### Validity & re-test policy (the calibration loop)

A profile is keyed by `(model_version, provider, prompt_template_hash,
probe_questionnaire_version, language)`. Re-test is required when **any** key
component changes — this matches the literature's "recalibrate when any element
of the stack changes":

| Trigger | Detection | Action |
|---|---|---|
| New model added to `config/models.json` | no profile row | UI offers one-click calibration |
| Provider drift / pinning change | `responses.provider` differs from profile | profile → `stale`, warn |
| API silently upgrades the model | `model_version` string changes | new profile needed |
| Prompt template edited | `prompt_template_hash` changes | all profiles → `stale` |
| Probe questionnaire revised | new questionnaire version | new profiles needed |
| Time | `valid_until` (default: 90 days, per the quarterly calibration-loop guidance) | profile → `stale` |

**Repeat-for-distribution** (optional, explicit): N independent probe runs of the
same key → `metrics_json` stores per-metric distributions and paired-bootstrap
(500 resamples) confidence intervals instead of point values. Default is a single
run (2 seeds already give the noise floor); repeats are for when a model's
run-to-run variance itself is the research question.

### UI: "Modellek" tab

One row per configured model: calibration status chip (érvényes / elavult /
hiányzik), profile summary (Pollyanna offset, invalid%, PC/RS), a **model card**
detail view (Provenance Card pattern: specs, probe version, dates, metrics,
known risks), and a "Kalibráció indítása" button that launches the probe runs
(null + name-only conditions) into the system project.

## 3. Control arm in every research run

Run config gains `baselineArm: boolean` (default **true**). When on, the runner
fires one persona-free cell per (question × rotation × seed) in addition to the
persona cells.

- Storage: `responses.persona_id = NULL`, `elicitation condition = 'baseline'`
  recorded in the row (never mixed with persona cells in aggregation).
- Prompt framing: "a survey respondent", **no profile block, never
  "answer as yourself"** (assistant-role trap).
- Cost: with P personas the arm adds ~1/P overhead (17% at 6 personas).
- Results view: per question, the baseline distribution is drawn alongside the
  persona distributions, and the **persona effect** is computed in code as the
  JS divergence between each persona's distribution and the baseline arm.
  A persona whose divergence is within the seed-noise floor is flagged:
  "a perszóna itt nem téríti el a modellt a defaulttól".

Why an arm inside the run, not just the registry profile: the literature is
explicit that without an in-run control you cannot tell persona effect from
default drift — the arm shares the run's exact template, provider, moment in
time and questionnaire, which the registry profile (different questionnaire,
different day) cannot guarantee.

## 4. Integration into evaluation

The judge prompt gains a **model-calibration section**, computed in code:

- the model's Pollyanna offset and prior-bias summary from the active profile;
- per-question baseline-arm distribution and each persona's divergence from it;
- mandatory instructions: interpret persona results *relative to the baseline*;
  where persona ≈ baseline, say the persona added nothing; treat positive
  product-concept results with the measured Pollyanna offset in mind; the
  stereotyping caveat (Δη² would need human data — until then, differences
  between personas are upper bounds, not findings).

The evaluation record stores which `model_profile.id` was in context, so any
evaluation is auditable against the calibration it used.

## 5. Rollout phases

- **M1**: control arm in the runner + results view + persona-effect divergence
  (needs #14 null-persona support; supersedes it).
- **M2**: `model_profiles` registry + "Modellek" tab + one-click calibration +
  staleness triggers (provider drift detection already possible via
  `responses.provider`). ✅ v0.15.0 — with two documented gaps, see §7.
- **M3**: evaluation integration (judge prompt section + profile reference on
  the evaluation record).
- **M4**: repeat-for-distribution + bootstrap CIs; PriDe-style prior correction
  offered as an *optional, clearly labelled* re-scoring view (never silently
  applied to raw data — the append-only log stays untouched).

## 6. Transparency

Every model profile renders as a model card; every evaluation cites its profile;
the probe questionnaire and this design are public. The six-pillar transparency
checklist applies to calibration runs too (population = "the model itself",
which the project card must state explicitly).

## 7. What M2 actually shipped (and what it did not)

Shipped: the `model_profiles` table, metrics computed in code from the
persona-free cells of calibration runs, the five-part profile key with staleness
detection and stated reasons, the "Modellek" tab with a status chip per
configured model, the model card, and a one-click calibration launch (an ordinary
run: probe questionnaire, no personas, control arm on).

Two deliberate departures from §2, both visible in the UI rather than hidden:

- **Positivity offset instead of the Pollyanna offset.** The design names the
  *product-evaluation trap items*. The probe questionnaire has no way to mark an
  item as a trap — questions carry no role field — so the shipped metric is the
  mean position of the default answer on every *directed* scale
  (ordinal/frequency), centred on the scale midpoint. It is the same shape of
  claim, measured over a wider and less specific set of items, and the model card
  says so. Marking trap items needs a question-level role field and belongs with
  the probe redesign.
- **The probe is data, not code.** §2 assumes a single canonical probe
  questionnaire. The platform is public and generic, so the calibration launch
  takes *any* questionnaire as the probe and the profile records which one
  (id + version) it used. A profile measured on one probe is stale against
  another, which is what the key already enforces.

Not in M2 (unchanged): the prior-bias vector is *reported*, never applied as a
correction (that is M4, and even then only as a clearly labelled re-scoring view);
the evaluation prompt does not yet cite the profile (M3).

## 8. UI rework: the workflow lives on the model card (post-M2)

The M2 UI put the launch form and a run-id textarea in collapsed sections under
the model list, and an uncalibrated model's card was a dead end — a warning with
no action. Reworked so every step sits where the researcher already is:

- The **model card carries the whole workflow** as four numbered steps: pick the
  probe questionnaire (or jump to Kérdőívek when none exists), launch, follow
  this model's calibration runs live, and record the profile from finished runs
  via a checkbox picker — run ids are never typed or copied.
- Calibration runs carry a `calibration: true` marker in their run config so the
  UI can attribute them to a model without parsing the human-facing run name.
- The **Modellek tab opens with the numbered "A kalibráció menete" guide**, and
  uncalibrated/stale list rows carry a Kalibrálás/Újrakalibrálás button, not
  just a status chip.
- The tab-level "Profil rögzítése" form offers the model's completed calibration
  runs as checkboxes instead of a free-text id field.
- The **context sidebar shows per-model calibration status** on every tab; a row
  opens the model card. Launching a calibration lands on the model card, where
  the new run is visible with live status (it remains an ordinary run in
  Futtatások too).
