// Model calibration rendering ("Modellek" tab). Pure string builders (no DOM
// access) so they stay unit-testable; model-view.js does the loading and wiring.
// Every interpolated value goes through escapeHtml.

const CALIBRATION_STATUS_LABELS = {
  valid: 'érvényes',
  stale: 'elavult',
  missing: 'hiányzik'
};

const CALIBRATION_TOOLTIPS = {
  status:
    'A profil azt méri, mit válaszol a modell perszóna NÉLKÜL. Csak arra a pontos összeállításra érvényes, amin mérték: modellverzió, szolgáltató, elicitációs sablon, próba-kérdőív verziója és nyelv. Bármelyik változik, a profil elavul.',
  positivity:
    'Mennyire tolódik a modell alapértelmezett válasza a skála pozitív vége felé az irányított (ordinális/gyakorisági) kérdéseken. 0 a skála közepe, +0.5 a teteje. A kérdések azonos súllyal számítanak, ezért egy rövid (kétfokú) skála nagyobbat lendít az átlagon, mint egy ötfokú — a kérdésenkénti értékek külön is látszanak lejjebb. A tervben szereplő Pollyanna-eltolás mérhető közelítése: a próba egyelőre nem jelöli külön a termékértékelő csapdakérdéseket, ezért ez minden irányított skálát lefed — tehát tágabb és gyengébb állítás.',
  priorBias:
    'Pozíciófüggő torzítás: a kiegyensúlyozott permutáció után minden opció ugyanannyiszor áll minden pozícióban, így egy tartalom alapján válaszoló modell egyenletesen oszlik el. Az érték a legnagyobb eltérés az egyenletes aránytól.',
  cells: 'Hány perszóna nélküli cella áll a profil mögött, és mennyibe került a mérés.',
  missing:
    'Ehhez a modellhez még nincs mérés. Amíg nincs, a vele készült perszóna-eredményekhez nincs mihez viszonyítani: nem tudjuk elkülöníteni a perszóna hatását a modell alapértelmezett válaszától.'
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
  return `
    <div class="list-item list-item-clickable" data-model="${escapeHtml(entry.model)}"
         role="button" tabindex="0" aria-label="Modell kalibrációjának megnyitása: ${escapeHtml(entry.label)}">
      <div>
        <div class="list-item-title">${escapeHtml(entry.label)}</div>
        <div class="list-item-meta">${escapeHtml(meta)}</div>
      </div>
      ${calibrationStatusChip(entry.status)}
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
 * The model card. Deliberately states what the profile is NOT: a measured
 * default is a reference point for reading persona results, not a correction
 * applied to them — the raw log is never touched.
 */
function renderModelCard(entry, profile) {
  if (!profile) {
    return `
      <div class="detail-section">
        <p class="methodology-warning">${escapeHtml(CALIBRATION_TOOLTIPS.missing)}</p>
      </div>
    `;
  }
  const metrics = profile.metrics || {};
  const priorBias = metrics.priorBias || {};
  const provenance = metrics.provenance || {};

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
    ${detailSection('Pozíció-preferencia', positionBars, CALIBRATION_TOOLTIPS.priorBias)}
    ${detailSection('Alapértelmezett válaszok kérdésenként', `<div class="detail-grid">${questions}</div>`)}
  `;
}
