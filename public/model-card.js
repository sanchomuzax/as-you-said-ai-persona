// Model calibration rendering ("Modellek" tab). Pure string builders (no DOM
// access) so they stay unit-testable; model-view.js does the loading and wiring.
// Every interpolated value goes through escapeHtml.

const CALIBRATION_STATUS_LABELS = {
  valid: 'érvényes',
  stale: 'elavult',
  missing: 'hiányzik'
};

/**
 * Issue #28: "Szolgáltató rögzítése" used to be a free-text field expecting the
 * researcher — a media professional, not a developer — to type OpenRouter's
 * internal provider slug from memory (e.g. `deepinfra/fp4`, not the display
 * name `DeepInfra` — the two are not interchangeable, and nothing explained
 * that). Shared by every form that pins a provider (run, interview,
 * calibration — tab-level and this on-card one), so the explanation and the
 * "don't silently default" choice read identically wherever it appears.
 * Deliberately NOT hover-only (issue #12's own lesson, see calibrationStatusChip
 * above): a title attribute reaches neither a keyboard-only nor a touch user,
 * so this is rendered as visible text next to the field, not just a tooltip.
 */
const PROVIDER_NONE_VALUE = '';
const PROVIDER_FIELD_NOTE =
  'Ugyanaz a modell szolgáltatónként — sőt kvantálásonként (pl. fp4, fp8: a modellsúlyok tömörítési szintje, ' +
  'ami a válasz sebességét, költségét és néha kis mértékben a minőségét is befolyásolja) — kicsit másképp ' +
  'válaszolhat. A választás rögzíti, KITŐL jöjjön a válasz, hogy a mérés megismételhető legyen. „Nem rögzítem” ' +
  'esetén az OpenRouter szabadon válogat a szolgáltatók között: kényelmesebb, de a profil/futtatás kevésbé lesz ' +
  'reprodukálható, mert a következő hívás akár másik szolgáltatótól is jöhet.';

/** "DeepInfra — fp4 kvantálás", or just the name when no quantization is known. */
function providerOptionLabel(opt) {
  return opt.quantization ? `${opt.providerName} — ${opt.quantization} kvantálás` : opt.providerName;
}

/** Per-option detail: hover bonus, never the only place the explanation lives. */
function providerOptionTitle(opt) {
  const parts = [];
  if (opt.quantization) {
    parts.push(
      `${opt.quantization} kvantálás: a modellsúlyok tömörített változata — gyorsabb és olcsóbb, de a válasz ` +
        'kis mértékben eltérhet a teljes pontosságú változattól.'
    );
  }
  if (opt.observedCount) {
    parts.push(`Ezt a szolgáltatót korábban ${opt.observedCount} alkalommal használta ez a modell ebben a rendszerben.`);
  } else if (opt.source === 'catalog') {
    parts.push('Az OpenRouter szerint jelenleg kínálja ezt a modellt, de ebben a rendszerben még nem szolgálta ki.');
  }
  return parts.join(' ');
}

/**
 * The dropdown's `<option>`s: "Nem rögzítem" first and selected by default
 * unless `selectedValue` names a real option, then every provider actually
 * observed for this model (state/DB) or, when reachable, offered by
 * OpenRouter's live catalog — never a hardcoded list (issue #28 requirement
 * 1: real data rots less than a maintained list).
 */
function renderProviderSelectOptions(options, selectedValue) {
  const opts = Array.isArray(options) ? options : [];
  const noneSelected = !opts.some((o) => o.value === selectedValue);
  const noneOption =
    `<option value="${escapeHtml(PROVIDER_NONE_VALUE)}" ${noneSelected ? 'selected' : ''} ` +
    `title="A profil/futtatás kevésbé lesz reprodukálható: a következő hívás bármelyik szolgáltatótól jöhet.">` +
    `Nem rögzítem (bármelyik szolgáltató)</option>`;
  const providerOptionsHtml = opts
    .map(
      (o) =>
        `<option value="${escapeHtml(o.value)}" ${o.value === selectedValue ? 'selected' : ''} ` +
        `title="${escapeHtml(providerOptionTitle(o))}">${escapeHtml(providerOptionLabel(o))}</option>`
    )
    .join('');
  return noneOption + providerOptionsHtml;
}

const CALIBRATION_TOOLTIPS = {
  status:
    'A profil azt méri, mit válaszol a modell perszóna NÉLKÜL. Csak arra a pontos összeállításra érvényes, amin mérték: modellverzió, szolgáltató, elicitációs sablon, próba-kérdőív verziója és nyelv. Bármelyik változik, a profil elavul.',
  positivity:
    'Mennyire tolódik a modell alapértelmezett válasza a skála pozitív vége felé az irányított (ordinális/gyakorisági) kérdéseken. 0 a skála közepe, +0.5 a teteje. A kérdések azonos súllyal számítanak, ezért egy rövid (kétfokú) skála nagyobbat lendít az átlagon, mint egy ötfokú — a kérdésenkénti értékek külön is látszanak lejjebb. A tervben szereplő Pollyanna-eltolás mérhető közelítése: a próba egyelőre nem jelöli külön a termékértékelő csapdakérdéseket, ezért ez minden irányított skálát lefed — tehát tágabb és gyengébb állítás.',
  priorBias:
    'Pozíciófüggő torzítás: a kiegyensúlyozott permutáció után minden opció ugyanannyiszor áll minden pozícióban, így egy tartalom alapján válaszoló modell egyenletesen oszlik el. Az érték a legnagyobb eltérés az egyenletes aránytól.',
  cells: 'Hány perszóna nélküli cella áll a profil mögött, és mennyibe került a mérés.',
  missing:
    'Profil nélkül az eredmények önmagukban olvasandók; nem tudjuk megmondani, mennyi a modell alapértelmezett viselkedése és mennyi a perszóna hatása.'
};

function calibrationStatusChip(status) {
  const label = CALIBRATION_STATUS_LABELS[status] || status;
  const className =
    status === 'valid' ? 'badge badge-completed' : status === 'stale' ? 'badge badge-paused' : 'badge badge-pending';
  // Focusable and self-describing, like every other explained chip (issue #12):
  // a hover-only explanation reaches neither a keyboard nor a touch screen.
  return `<span class="${className} chip-explained" title="${escapeHtml(CALIBRATION_TOOLTIPS.status)}"
    tabindex="0" role="note" aria-label="${escapeHtml(label)} — ${escapeHtml(CALIBRATION_TOOLTIPS.status)}">${escapeHtml(label)}</span>`;
}

/** In a calibration view "not measured" must never be shown as a zero. */
function calibrationValue(value, formatter) {
  if (value === null || value === undefined) return '—';
  return formatter ? formatter(value) : String(value);
}

/** Signed, so a negative (pessimistic) offset is not read as a positive one. */
function formatSigned(value) {
  const rounded = Math.round(value * 1000) / 1000;
  return (rounded > 0 ? '+' : '') + rounded.toFixed(3);
}

/** Same rounding the plain (non-repeated) invalidRate/abstainRate fields already use, kept identical on purpose. */
function formatPercentValue(value) {
  return Math.round(value * 100) + '%';
}

/**
 * Issue #47 (M4a): each of the four scalar mutatók (positivityOffset,
 * priorBias.maxDeviation, invalidRate, abstainRate) also carries a repeated-run
 * bootstrap confidence interval (`metrics.repeated.<mutató>`). "Konfidencia-
 * intervallum" is jargon on its own, so this tooltip spells out what it means
 * for a media professional reading the card, not just a developer.
 */
const REPEATED_CI_TOOLTIP =
  'A megbízhatósági intervallum (más néven konfidencia-intervallum) azt mutatja meg, mennyire ingadozna ez az ' +
  'érték, ha a kalibrációs futtatásokat sokszor megismételnénk. A sáv nem szimmetrikus a középérték körül, ezért ' +
  'az alsó és a felső határ mindig külön szerepel, nem egyetlen plusz-mínusz értékként.';

/**
 * Renders one `MetricWithCI`-shaped value (src/lib/profile.ts) as plain text
 * for a `detailField`. Three cases, and they must stay visually distinct
 * (issue #40's lesson, repeated for M4a):
 *   - CI present, non-zero-width: point estimate + the low/high bounds, each
 *     formatted and signed separately — NEVER collapsed into "± x", since the
 *     bootstrap interval is not symmetric.
 *   - CI present but zero-width (low === high): a genuine measurement that
 *     happens not to vary — still a real range, shown the same way as above.
 *   - CI absent (`ci: null`, fewer than 3 usable runs): the point estimate is
 *     still shown, but paired with `ciUnavailableReason` verbatim instead of a
 *     range, so "could not measure" is never mistaken for "measured as zero".
 */
function renderRepeatedMetricValue(metric, formatter) {
  if (!metric) return null;
  const point = calibrationValue(metric.pointEstimate, formatter);
  if (metric.ci) {
    const runCount = Array.isArray(metric.perRun) ? metric.perRun.length : 0;
    return `${point} (95%-os intervallum: ${formatter(metric.ci.low)} – ${formatter(metric.ci.high)}, ${runCount} futásból)`;
  }
  const reason = metric.ciUnavailableReason || 'A megbízhatósági intervallum nem számítható ki.';
  return `${point} (nincs megbízhatósági intervallum — ${reason})`;
}

/**
 * The repeated-run section of the model card. Absent entirely (returns '')
 * when the profile predates issue #47 (`metrics.repeated` missing) — no CI is
 * fabricated for an old record, it simply has none to show.
 */
function renderRepeatedMetricsSection(metrics) {
  const repeated = metrics.repeated;
  if (!repeated) return '';
  const excludedNote =
    Array.isArray(repeated.excludedRunIds) && repeated.excludedRunIds.length > 0
      ? ` ${repeated.excludedRunIds.length} futás kimaradt belőle, mert nem fejeződött be.`
      : '';
  return detailSection(
    'Ismétléses mérés bizonytalansága',
    `<p class="detail-note">A lenti négy mutató ${escapeHtml(String(repeated.runCount))} futásból készült.${escapeHtml(excludedNote)}</p>
     <div class="detail-grid">
       ${detailField('Alap-pozitivitás — futásonkénti', renderRepeatedMetricValue(repeated.positivityOffset, formatSigned), REPEATED_CI_TOOLTIP)}
       ${detailField('Pozíció-torzítás — futásonkénti', renderRepeatedMetricValue(repeated.priorBiasMaxDeviation, formatSigned), REPEATED_CI_TOOLTIP)}
       ${detailField('Érvénytelen válaszok — futásonkénti', renderRepeatedMetricValue(repeated.invalidRate, formatPercentValue), REPEATED_CI_TOOLTIP)}
       ${detailField('Tartózkodás — futásonkénti', renderRepeatedMetricValue(repeated.abstainRate, formatPercentValue), REPEATED_CI_TOOLTIP)}
     </div>`,
    REPEATED_CI_TOOLTIP
  );
}

function modelListItem(entry) {
  const summary = entry.summary;
  const meta = summary
    ? [
        `alap-pozitivitás: ${calibrationValue(summary.positivityOffset, formatSigned)}`,
        `pozíció-torzítás: ${calibrationValue(summary.priorBiasMaxDeviation, formatSigned)}`,
        `érvénytelen: ${calibrationValue(summary.invalidRate, (v) => Math.round(v * 100) + '%')}`,
        `${calibrationValue(summary.cellCount)} cella`
      ].join(' · ')
    : 'Nincs mérés ehhez a modellhez.';
  // Missing/stale rows carry the action by name, not only a status chip: a chip
  // says what is wrong, a button says what to do about it. Clicking it opens the
  // same model card the row itself opens (the workflow lives there) — it exists
  // so the next step is visible from the list, not discovered by accident.
  const action =
    entry.status === 'valid'
      ? ''
      : `<button type="button" class="btn btn-primary btn-sm"
           aria-label="${entry.status === 'stale' ? 'Újrakalibrálás' : 'Kalibrálás'}: ${escapeHtml(entry.label)}">${
           entry.status === 'stale' ? 'Újrakalibrálás' : 'Kalibrálás'
         }</button>`;
  const limitedWarning = summary?.probeInterpretability === 'limited'
    ? '<p class="methodology-warning">Nem kalibrációs célra tervezett kérdőív — a profil korlátozottan értelmezhető.</p>'
    : '';
  return `
    <div class="list-item list-item-clickable" data-model="${escapeHtml(entry.model)}"
         role="button" tabindex="0" aria-label="Modell kalibrációjának megnyitása: ${escapeHtml(entry.label)}">
      <div>
        <div class="list-item-title">${escapeHtml(entry.label)}</div>
        <div class="list-item-meta">${escapeHtml(meta)}</div>
        ${limitedWarning}
      </div>
      <div class="list-item-actions">${action}${calibrationStatusChip(entry.status)}</div>
    </div>
  `;
}

function renderModelList(entries) {
  if (!entries || entries.length === 0) {
    return '<p class="placeholder">Nincs beállított modell.</p>';
  }
  return entries.map(modelListItem).join('');
}

/** Why the profile no longer describes the current stack — stated, not implied. */
function renderStalenessReasons(reasons) {
  if (!reasons || reasons.length === 0) return '';
  return `<div class="methodology-warning"><strong>A profil elavult.</strong><ul>${reasons
    .map((r) => `<li>${escapeHtml(r)}</li>`)
    .join('')}</ul>A számok azt írják le, ami a mérés idején igaz volt; a mostani beállításra nem érvényesek.</div>`;
}

/**
 * "X másodperce/perce/órája fut" for a running calibration row (issue #29) —
 * there was no elapsed-time concept anywhere in the app before this; derived
 * from the run's created_at, reusing format.js's parseUtcTimestamp so the same
 * "SQLite writes UTC without a zone marker" trap formatDateTime already
 * handles is not solved a second, slightly-different way here.
 */
function formatElapsed(createdAt) {
  const started = parseUtcTimestamp(createdAt);
  if (!started) return null;
  const seconds = Math.max(0, Math.round((Date.now() - started.getTime()) / 1000));
  if (seconds < 60) return `${seconds} másodperce fut`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} perce fut`;
  const hours = Math.round(minutes / 60);
  return `${hours} óra óta fut`;
}

/**
 * One calibration run of this model, as a clickable row with its live status.
 * A running/paused row also shows real progress (issue #29's second defect):
 * done/total cells with a percentage, tokens/cost spent so far, and elapsed
 * time — all already available on `run` (calibrationRunsFor in model-view.js
 * merges the live progress poll over the enriched GET /api/runs row, exactly
 * like every other run view), so nothing new is fetched to render this.
 */
function calibrationRunRow(run) {
  const isResumable = ['pending', 'paused', 'budget_exhausted', 'failed'].includes(run.status);
  const isActive = run.status === 'running' || isResumable;
  const totalCells = run.totalCells ?? 0;
  const done = run.done ?? 0;
  const usage = run.usage || {};
  const pct = totalCells > 0 ? Math.min(Math.round((done / totalCells) * 100), 100) : 0;
  const elapsed = isActive ? formatElapsed(run.created_at) : null;

  const progress = isActive
    ? `
      <div class="progress-bar" title="${escapeHtml(TOOLTIPS.cells)}">
        <div class="progress-fill" style="width: ${pct}%"></div>
      </div>
      <div class="list-item-meta">${escapeHtml(
        `${formatNumber(done)} / ${formatNumber(totalCells)} cella (${pct}%) · ${formatNumber(usage.totalTokens || 0)} token · ${formatCost(usage.costUsd || 0)} USD${elapsed ? ' · ' + elapsed : ''}`
      )}</div>`
    : '';

  const stopButton = isActive
    ? `<button type="button" class="btn btn-danger btn-sm" data-action="stop" data-run="${escapeHtml(run.id)}"
         aria-label="Kalibráció leállítása: ${escapeHtml(run.name)}">Leállítás</button>`
    : '';
  const resumeButton = isResumable
    ? `<button type="button" class="btn btn-secondary btn-sm" data-action="resume" data-run="${escapeHtml(run.id)}"
         aria-label="Kalibráció folytatása: ${escapeHtml(run.name)}">Folytatás</button>`
    : '';
  const limitedWarning = run.probeInterpretability === 'limited'
    ? '<p class="methodology-warning">Nem kalibrációs célra tervezett kérdőív — a profil korlátozottan értelmezhető.</p>'
    : '';

  return `
    <div class="list-item list-item-clickable" data-cal-run="${escapeHtml(run.id)}"
         role="button" tabindex="0" aria-label="${openLabel('runs', run.name)}">
      <div>
        <div class="list-item-title">${escapeHtml(run.name)}</div>
        <div class="list-item-meta">${escapeHtml(formatDateTime(run.created_at))}</div>
        ${run.probeName ? `<div class="list-item-meta">Próba: ${escapeHtml(run.probeName)}${run.probeVersion ? ` — v${escapeHtml(run.probeVersion)}` : ''}</div>` : ''}
        ${limitedWarning}
        ${progress}
      </div>
      <div class="list-item-actions">${resumeButton}${stopButton}${statusBadge(run.status)}</div>
    </div>
  `;
}

/**
 * The calibration workflow, rendered ON the model card. The card used to be a
 * dead end for an uncalibrated model — a warning with nothing to act on, while
 * the launch form lived in a collapsed section of the tab below the list, and
 * recording the profile required copy-pasting run ids. Every step now sits
 * where the researcher already is, showing THIS model's actual state:
 *   1. pick the probe questionnaire (or jump to Kérdőívek when none exists),
 *   2. launch the calibration (a form posting /api/models/:model/calibrate),
 *   3. follow this model's calibration runs (live status, click to open),
 *   4. record the profile from finished runs — a checkbox picker, no id typing.
 * Controls use classes, not ids: the card re-renders and can exist alongside
 * the tab-level form.
 */
function renderCalibrationWorkflow(entry, context) {
  const probes = (context && context.probes) || [];
  const calRuns = (context && context.calibrationRuns) || [];
  const completed = calRuns.filter((r) => r.status === 'completed');
  // Issue #29: launching a SECOND calibration for the same model while one is
  // already running double-spends the budget and hits the #16 concurrency
  // risk. Scoped to THIS model's own runs only — a different model's launch
  // control must stay enabled, since calibrationRunsFor (model-view.js)
  // already filters calRuns down to one model before this ever sees them.
  const activeCalibration = calRuns.find((r) =>
    ['pending', 'running', 'paused', 'budget_exhausted', 'failed'].includes(r.status)
  );
  const heading = entry.status === 'missing' ? 'Kalibráció lépésről lépésre' : 'Újrakalibrálás lépésről lépésre';

  const step1 =
    probes.length === 0
      ? `<p class="detail-note">Még nincs kérdőív, amit próbaként használhatnál. Előbb hozz létre egyet a
           Kérdőívek fülön (a demó-seed is tartalmaz egyet), aztán gyere vissza ide.</p>
         <button type="button" class="btn btn-secondary" data-action="goto-questionnaires">Ugrás a Kérdőívek fülre</button>`
      : `<p class="detail-note">A választó csak kalibrációs célra kijelölt, verziózott próba-kérdőíveket mutat.</p>`;

  const ordinaryProbeWarning = probes.some((q) => q.isCalibrationProbe === false)
    ? '<p class="methodology-warning">Ez a kérdőív nem kalibrációs célra tervezett — az eredmény korlátozottan értelmezhető.</p>'
    : '';

  const runningNotice = activeCalibration
    ? `<p class="detail-note detail-note-warning">Már van aktív kalibráció ehhez a modellhez — előbb folytasd vagy állítsd le lent, mielőtt újat indítanál.</p>`
    : '';

  const launchForm =
    probes.length === 0
      ? ''
      : `${ordinaryProbeWarning}${runningNotice}<form class="model-card-calibrate-form form-grid" data-model="${escapeHtml(entry.model)}">
          <div class="form-group">
            <label>Próba-kérdőív
              <select class="model-card-probe-select" required ${activeCalibration ? 'disabled' : ''}>
                <option value="">-- Válassz próba-kérdőívet --</option>
                ${probes.map((q) => `<option value="${escapeHtml(q.id)}">${escapeHtml(q.name)} — v${escapeHtml(q.version)}</option>`).join('')}
              </select>
            </label>
          </div>
          <div class="form-group">
            <label title="Szolgáltató rögzítése nélkül a profil nem egyetlen kiszolgálót ír le, és a szolgáltató-váltás azonnal elavulttá teszi.">Szolgáltató rögzítése (ajánlott)
              <select class="model-card-provider-select" ${activeCalibration ? 'disabled' : ''}>
                ${renderProviderSelectOptions((context && context.providerOptions) || [], '')}
              </select>
            </label>
            <p class="form-note">${escapeHtml(PROVIDER_FIELD_NOTE)}</p>
          </div>
          <button type="submit" class="btn btn-primary" ${activeCalibration ? 'disabled' : ''}>Kalibrációs futtatás indítása</button>
        </form>`;

  const runsList =
    calRuns.length === 0
      ? '<p class="detail-note">Ehhez a modellhez még nem indult kalibrációs futtatás.</p>'
      : calRuns.map(calibrationRunRow).join('');

  const recorder =
    completed.length === 0
      ? '<p class="detail-note">Amint egy kalibrációs futtatás befejeződik, itt egy kattintással profillá rögzítheted.</p>'
      : `<div class="checkbox-group">
           ${completed
             .map(
               (r, i) => `
             <div class="checkbox-item">
               <input type="checkbox" class="model-card-runpick" id="calRunPick_${i}" value="${escapeHtml(r.id)}" ${i === 0 ? 'checked' : ''}>
               <label for="calRunPick_${i}">${escapeHtml(r.name)} — ${escapeHtml(formatDateTime(r.created_at))}</label>
             </div>`
             )
             .join('')}
         </div>
         <button type="button" class="btn btn-primary" data-action="record-profile">Profil rögzítése a kijelölt futtatás(ok)ból</button>
         <p class="detail-note">A mért összeállítást (modellverzió, szolgáltató, próba-kérdőív) a rendszer a
           válaszokból olvassa vissza, nem kézzel megadott adatból.</p>`;

  return `
    <div class="detail-section calibration-workflow">
      <h3>${escapeHtml(heading)}</h3>
      <div class="calibration-step">
        <h4>1. Próba-kérdőív</h4>
        ${step1}
      </div>
      <div class="calibration-step">
        <h4>2. Kalibráció indítása</h4>
        ${launchForm}
      </div>
      <div class="calibration-step">
        <h4>3. A futtatás követése</h4>
        <p class="detail-note">A kalibráció közönséges futtatás: itt és a Futtatások fülön is követhető, szüneteltethető.</p>
        ${runsList}
      </div>
      <div class="calibration-step">
        <h4>4. Profil rögzítése</h4>
        ${recorder}
      </div>
    </div>
  `;
}

/**
 * Generates an actionable message for a missing calibration profile. The message
 * explains what the absence means and tells the researcher what to do next,
 * based on whether there are completed calibration runs, probe questionnaires, etc.
 */
function renderMissingProfileMessage(context) {
  const explanation = `A profil nélkül az eredmények önmagukban olvasandók; nincs mihez viszonyítani a perszóna hatását a modell alapértelmezett viselkedéséhez képest.`;

  const probes = (context && context.probes) || [];
  const calRuns = (context && context.calibrationRuns) || [];
  const completed = calRuns.filter((r) => r.status === 'completed');

  let nextStep = '';
  if (completed.length > 0) {
    const run = completed[0];
    nextStep = `<p class="detail-note"><strong>Következő lépés:</strong> Rögzítsd a profilt a befejezett futásból — alább a "4. Profil rögzítése" lépésben.</p>`;
  } else if (probes.length > 0) {
    nextStep = `<p class="detail-note"><strong>Következő lépés:</strong> Indíts kalibrációs futtatást a próba-kérdőívvel — az alábbi lépéseket követve.</p>`;
  } else {
    nextStep = `<p class="detail-note"><strong>Következő lépés:</strong> Hozz létre egy próba-kérdőívet a Kérdőívek fülön, majd térj vissza a kalibrációhoz.</p>`;
  }

  return `
    <div class="detail-section">
      <p class="methodology-warning">${escapeHtml(explanation)}</p>
      ${nextStep}
    </div>
  `;
}

/**
 * The model card. Deliberately states what the profile is NOT: a measured
 * default is a reference point for reading persona results, not a correction
 * applied to them — the raw log is never touched. `context` (probes +
 * calibration runs) feeds the on-card workflow; without it the workflow still
 * renders, in its "no probe questionnaire yet" state.
 */
function renderModelCard(entry, profile, context) {
  if (!profile) {
    return `
      ${renderMissingProfileMessage(context)}
      ${renderCalibrationWorkflow({ ...entry, status: 'missing' }, context)}
    `;
  }
  const metrics = profile.metrics || {};
  const priorBias = metrics.priorBias || {};
  const provenance = metrics.provenance || {};
  const limitedWarning = metrics.probeInterpretability === 'limited'
    ? '<p class="methodology-warning">Nem kalibrációs célra tervezett kérdőív — a profil korlátozottan értelmezhető.</p>'
    : '';

  const positionBars =
    Array.isArray(priorBias.byPosition) && priorBias.byPosition.length > 0
      ? `<div class="position-bias">${priorBias.byPosition
          .map(
            (share, i) =>
              `<div class="position-bias-row"><span class="position-bias-label">${i + 1}. hely</span>
                 <div class="option-bar-track"><div class="option-bar-fill" style="width: ${Math.round(share * 100)}%"></div></div>
                 <span class="position-bias-value">${Math.round(share * 100)}%</span></div>`
          )
          .join('')}</div>`
      : '<p class="detail-note">Nincs olyan válasz, amely pontosan egy opciót jelölt meg, így a pozíció-torzítás nem mérhető.</p>';

  const questions = Array.isArray(metrics.perQuestion) && metrics.perQuestion.length > 0
    ? metrics.perQuestion
        .map((q) => {
          const options = q.options || [];
          // Naming a "default answer" with nothing behind it would assert a
          // result that was never observed: an all-zero distribution resolves to
          // the first option only because it is first.
          const top = (q.defaultDistribution || []).reduce(
            (best, value, i) => (value > best.value ? { value, i } : best),
            { value: 0, i: -1 }
          );
          const measured = q.aggregatedResponseCount > 0 && top.i >= 0 && top.value > 0;
          const legacy = q.legacyElicitationCount
            ? ` · ${escapeHtml(String(q.legacyElicitationCount))} cella más elicitációs móddal készült, kihagyva`
            : '';
          const value = measured
            ? `${escapeHtml(options[top.i])} (${Math.round(top.value * 100)}%, ${escapeHtml(calibrationValue(q.aggregatedResponseCount))} cella)`
            : 'nem mérhető (nincs értékelhető válasz)';
          return `
            <div class="detail-field">
              <span class="detail-label">${escapeHtml(q.text)}</span>
              <span class="detail-value">${value}${legacy}</span>
            </div>`;
        })
        .join('')
    : '<p class="detail-note">Nincs kérdésszintű mérés.</p>';

  return `
    ${renderStalenessReasons(profile.reasons)}
    ${limitedWarning}
    <p class="methodology-warning">A profil viszonyítási pont, nem korrekció: a nyers válasznaplóhoz soha nem nyúlunk hozzá.
      Azt mondja meg, mit válaszol ez a modell perszóna nélkül — enélkül nem választható el a perszóna hatása a modell alapértelmezésétől.</p>
    ${detailSection(
      'Mérési kulcs',
      `<div class="detail-grid">
        ${detailField('Modell (kért)', profile.modelRequested)}
        ${detailField('Modellverzió', profile.modelVersion)}
        ${detailField('Szolgáltató', profile.provider)}
        ${detailField('Próba-kérdőív', profile.probeName ? `${profile.probeName} (v${profile.probeVersion})` : profile.probeQuestionnaireId)}
        ${detailField('Nyelv', profile.language)}
        ${detailField('Sablon-ujjlenyomat', profile.promptTemplateHash)}
        ${detailField('Mérve', formatDateTime(profile.createdAt))}
        ${detailField('Érvényes eddig', formatDateTime(profile.validUntil))}
      </div>`,
      CALIBRATION_TOOLTIPS.status
    )}
    ${detailSection(
      'Mért mutatók',
      `<div class="detail-grid">
        ${detailField('Alap-pozitivitás', calibrationValue(metrics.positivityOffset, formatSigned), CALIBRATION_TOOLTIPS.positivity)}
        ${detailField('Pozíció-torzítás (max. eltérés)', calibrationValue(priorBias.maxDeviation, formatSigned), CALIBRATION_TOOLTIPS.priorBias)}
        ${detailField('Érvénytelen válaszok', calibrationValue(metrics.invalidRate, (v) => Math.round(v * 100) + '%'))}
        ${detailField('Tartózkodás', calibrationValue(metrics.abstainRate, (v) => Math.round(v * 100) + '%'))}
        ${detailField('Cellák', calibrationValue(provenance.cellCount), CALIBRATION_TOOLTIPS.cells)}
        ${detailField('Mérés költsége (USD)', calibrationValue(provenance.costUsd, formatCost))}
      </div>`
    )}
    ${renderRepeatedMetricsSection(metrics)}
    ${detailSection('Pozíció-preferencia', positionBars, CALIBRATION_TOOLTIPS.priorBias)}
    ${detailSection('Alapértelmezett válaszok kérdésenként', `<div class="detail-grid">${questions}</div>`)}
    ${renderCalibrationWorkflow({ ...entry, status: profile.status || entry.status }, context)}
  `;
}
