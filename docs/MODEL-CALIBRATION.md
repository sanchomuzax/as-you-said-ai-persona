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
  style). Lives as a normal questionnaire in a dedicated system project; versioned
  like any questionnaire (lineage + version).
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
  `responses.provider`).
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
