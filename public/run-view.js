// Run detail controller: header, subtabs (overview / responses / evaluation)
// and the manual evaluation trigger.

// ----- Run Detail View -----
function findRunById(runId) {
  return state.runs.find(r => r.id === runId);
}

/**
 * Issue #46: a freshly opened run must land on "Válaszok" — the tab with the
 * per-option row cards from the final mockup — not "Áttekintés", which is the
 * old thin-bar layout and used to be everyone's first (and often only) view.
 * `state.currentSubtab` (public/app.js) is initialized to 'overview' and this
 * file cannot touch app.js, so the default can't just be flipped there.
 * Instead: only the FIRST run open of the session (before the researcher has
 * ever clicked a subtab button themselves) is forced to 'responses'; once
 * they pick a subtab explicitly, that choice — already tracked via
 * state.currentSubtab — sticks for every later run open, exactly as before.
 */
let subtabPickedByUser = false;

async function openRunDetail(runId, updateHash) {
  // Issue #30 root cause: this used to close only the entity detail view
  // (closeEntityDetail(false)), so a run opened from the model card (or from
  // the interview detail) left that OTHER view's `display: block` standing —
  // two full-page detail sections stacked on top of each other. One shared
  // teardown (app.js) now hides every other detail view, not just the one
  // this function happened to know about.
  closeAllDetailViews('runDetailView');
  state.currentRunId = runId;
  closeProvenancePanel();
  document.querySelector('.tab-content').style.display = 'none';
  document.getElementById('runDetailView').style.display = 'block';
  if (updateHash) setHash('runs', runId);
  // Details drawer defaults to closed on every run open (docs/UI-DESIGN.md
  // §0), so it never carries an "open" state over from a previously
  // inspected run.
  const details = document.getElementById('runDetailDetails');
  const toggleBtn = document.getElementById('runDetailDetailsToggle');
  if (details && !details.hidden) {
    details.hidden = true;
    toggleBtn?.setAttribute('aria-expanded', 'false');
    toggleBtn?.classList.remove('active');
    document.getElementById('runDetailHeader')?.classList.remove('details-open');
  }

  await refreshRunDetailHeader(runId);
  await loadSubtab(subtabPickedByUser ? (state.currentSubtab || 'responses') : 'responses');
}

function closeRunDetail(updateHash) {
  state.currentRunId = null;
  document.getElementById('runDetailView').style.display = 'none';
  document.querySelector('.tab-content').style.display = 'block';
  if (updateHash) setHash(state.activeTab || 'runs', null);
}

document.getElementById('runDetailBackBtn')?.addEventListener('click', () => {
  closeRunDetail(true);
  // Same expression closeRunDetail() just used to pick the hash (issue #23):
  // Vissza returns to whichever tab the researcher actually opened this run
  // from, not always Futtatások. A card opened from Áttekintés never touches
  // state.activeTab, so hard-coding 'runs' here left the address bar and the
  // visible pane disagreeing after Back. The entity-row entry point already
  // sets state.activeTab = 'runs' itself (public/entity-view.js), so it keeps
  // landing on Futtatások exactly as before.
  setActiveTab(state.activeTab || 'runs');
  // The list is re-rendered here, so focus is restored only after the new
  // markup is in place — on the card with the same id, not the discarded node.
  void refreshRunsList().then(restoreDetailFocus);
});

// Details drawer (docs/UI-DESIGN.md §0): controls, stat chips, the
// stale-version notice and CSV export live behind this toggle, closed by
// default so the question and response cards start right under the compact
// header instead of the middle of the screen. See #runDetailHeader's
// .details-open rule in public/style.css for why the progress bar reappears
// while this is open too.
document.getElementById('runDetailDetailsToggle')?.addEventListener('click', () => {
  const details = document.getElementById('runDetailDetails');
  const toggleBtn = document.getElementById('runDetailDetailsToggle');
  const header = document.getElementById('runDetailHeader');
  if (!details || !toggleBtn) return;
  const willOpen = details.hidden;
  details.hidden = !willOpen;
  toggleBtn.setAttribute('aria-expanded', String(willOpen));
  toggleBtn.classList.toggle('active', willOpen);
  header?.classList.toggle('details-open', willOpen);
});

function renderRunDetailHeaderFromCache(runId) {
  const run = findRunById(runId);
  if (!run) return;
  // Blocker #1: `|| {}` used to fabricate a "0 / 0 cella · 0 token" render
  // for a run with no cached live progress — runProgressFromRow (runs-list.js)
  // is the row's own real totals instead, the same fallback renderRunCard uses.
  const progress = state.runProgress[runId] || runProgressFromRow(run);
  renderRunDetailHeader(run, progress);
}

function renderRunDetailHeader(run, progress) {
  const status = progress.status || run.status;
  // docs/UI-DESIGN.md §6 "Live progress": the progress bar must stay visible
  // while a run is actually running even though it now lives outside the
  // (closed-by-default) details drawer — see .run-detail-progress's display
  // rule in public/style.css, keyed off this class.
  document.getElementById('runDetailHeader')?.classList.toggle('is-running', status === 'running');
  document.getElementById('runDetailTitle').textContent = run.name || '';
  const statusEl = document.getElementById('runDetailStatus');
  statusEl.className = badgeClassForStatus(status);
  statusEl.title = statusTooltip(status);
  statusEl.innerHTML = (status === 'running' ? '<span class="pulse-dot"></span>' : '') + escapeHtml(statusLabel(status));

  const totalCells = progress.totalCells ?? 0;
  const done = progress.done ?? 0;
  const invalid = progress.invalid ?? 0;
  const abstained = progress.abstained ?? 0;
  const usage = progress.usage || {};
  const pct = totalCells > 0 ? Math.min((done / totalCells) * 100, 100) : 0;
  const invPct = invalidPct(invalid, totalCells);

  document.getElementById('runDetailProgressFill').style.width = pct + '%';
  announceRunProgress(status, done, totalCells, invalid, abstained);
  document.getElementById('runDetailStats').innerHTML = runStatChips({
    done,
    totalCells,
    invalid,
    abstained,
    invPct,
    totalTokens: usage.totalTokens || 0,
    cachedTokens: usage.cachedTokens || 0,
    promptTokens: usage.promptTokens || 0,
    costUsd: usage.costUsd || 0,
    avgLatencyMs: progress.avgLatencyMs
  }) + renderProviderChip(progress.providers);
  document.getElementById('runDetailControls').innerHTML = runControlButtons({ id: run.id, status }, 'detail');
  document.getElementById('runExportLink').href = '/api/runs/' + run.id + '/export.csv';
}

async function refreshRunDetailHeader(runId) {
  try {
    const run = findRunById(runId) || (await apiCall('GET', '/api/runs/' + runId)).run;
    let progress;
    try {
      progress = await apiCall('GET', `/api/runs/${runId}/progress`);
      state.runProgress[runId] = progress;
    } catch {
      // Blocker #1: this used to fall back to `state.runProgress[runId] || {}`
      // — empty for any run that was never live-polled, which since issue #22
      // is every non-running run (boot no longer fans out /progress, and the
      // 5s timer targets running rows only). That rendered a fabricated
      // "0 / 0 cella · 0 token · 0.0000 USD" for a run that may have spent
      // real tokens. Prefer an earlier successful live poll if one is cached
      // (freshest known-good data); otherwise fall back to the list row's own
      // totals (runProgressFromRow, runs-list.js) — the same real numbers
      // renderRunCard already shows for this run, never a fabricated 0.
      progress = state.runProgress[runId] || runProgressFromRow(run);
    }
    renderRunDetailHeader(run, progress);
    // The notice lives in the header, not in a sub-tab: a reader who only opens the
    // overview would otherwise never learn the run refers to superseded versions.
    const staleEl = document.getElementById('runStaleVersions');
    if (staleEl) staleEl.innerHTML = renderStaleVersionNotice(progress.staleVersions);
  } catch (err) {
    // ignore transient errors
  }
}

document.querySelectorAll('.subtab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    subtabPickedByUser = true;
    loadSubtab(btn.dataset.subtab);
  });
});

async function loadSubtab(name) {
  state.currentSubtab = name;
  // The panel is pinned to one response; leaving its context must not leave it
  // hovering over a different run's data.
  closeProvenancePanel();
  document.querySelectorAll('.subtab-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`.subtab-btn[data-subtab="${name}"]`)?.classList.add('active');
  document.querySelectorAll('.subtab-pane').forEach(p => p.classList.remove('active'));
  document.getElementById('subtab-' + name)?.classList.add('active');

  if (!state.currentRunId) return;

  if (name === 'overview') {
    await loadOverviewTab(state.currentRunId);
  } else if (name === 'responses') {
    await loadResponsesTab(state.currentRunId);
  } else if (name === 'transcript') {
    await loadTranscriptTab(state.currentRunId);
  } else if (name === 'evaluation') {
    await loadEvaluationTab(state.currentRunId);
  }
}

/**
 * The progress bar and the chips are purely visual. This is the same information
 * as one sentence, written into a polite live region — announced only when it
 * actually changes, so a poll every few seconds does not talk over the reader.
 */
function announceRunProgress(status, done, totalCells, invalid, abstained) {
  const region = document.getElementById('runStatusLive');
  if (!region) return;
  const parts = [
    `Állapot: ${statusLabel(status)}`,
    `${formatNumber(done)} / ${formatNumber(totalCells)} cella kész`
  ];
  if (invalid > 0) parts.push(`${formatNumber(invalid)} nem értelmezhető`);
  if (abstained > 0) parts.push(`${formatNumber(abstained)} tartózkodás`);
  const message = parts.join(', ') + '.';
  if (region.textContent !== message) region.textContent = message;
}

function renderOptionBars(question) {
  const options = question.options || [];
  const aggregated = question.aggregated || [];
  const multi = question.elicitationMode === 'multi_choice';
  const total = aggregated.reduce((a, b) => a + b, 0);
  // A calibration run has no personas at all, so the persona aggregate is empty.
  // Drawing it as "0%" for every option would assert a measured result of zero
  // where nothing was measured; the control arm is shown on its own instead.
  const personaMeasured = (question.aggregatedResponseCount || 0) > 0;
  const max = Math.max(1, ...aggregated);
  // Multi-select values are independent supports, so they must NOT be shown as
  // a share of a 100% total — that is exactly the reading the fix removes.
  const rowTooltip = multi ? TOOLTIPS.support : TOOLTIPS.distribution;

  const baseline = Array.isArray(question.baseline) ? question.baseline : null;
  return options.map((opt, i) => {
    const value = aggregated[i] || 0;
    const baselineValue = baseline ? baseline[i] || 0 : null;
    const baselinePct = baselineValue === null
      ? null
      : (multi ? Math.round(baselineValue * 100) : (baseline.reduce((a, b) => a + b, 0) > 0 ? Math.round((baselineValue / baseline.reduce((a, b) => a + b, 0)) * 100) : 0));
    const barPct = personaMeasured ? (value / max) * 100 : 0;
    const pct = multi
      ? Math.round(value * 100)
      : (total > 0 ? Math.round((value / total) * 100) : 0);
    const personaCell = personaMeasured
      ? `<span class="option-bar-pct">${pct}%${multi ? ' támogatottság' : ''} (${formatMetric(value)})</span>`
      : '<span class="option-bar-pct option-bar-pct-unmeasured">nincs perszóna-mérés</span>';
    return `
      <div class="option-bar-row" title="${escapeHtml(rowTooltip)}">
        <span class="option-bar-label">${escapeHtml(opt)}</span>
        <div class="option-bar-track">
          <div class="option-bar-fill${multi ? ' option-bar-fill-support' : ''}" style="width: ${barPct}%"></div>
        </div>
        ${personaCell}
        ${baselinePct === null ? '' : `<span class="option-bar-baseline" title="${escapeHtml(TOOLTIPS.baselineArm)}">kontroll: ${baselinePct}%</span>`}
      </div>
    `;
  }).join('');
}

function renderReferenceComparison(question) {
  const comparison = question.referenceComparison;
  if (question.referenceIssue) {
    return `<p class="detail-note detail-note-warning reference-comparison">A referencia nem értékelhető: ${escapeHtml(question.referenceIssue)}</p>`;
  }
  if (!comparison) return '';
  const formatPercent = (share) => {
    const value = Math.round(share * 1000) / 10;
    return value.toLocaleString('hu-HU', { maximumFractionDigits: 1 }) + '%';
  };
  const referencePct = comparison.valueLabel || formatPercent(comparison.referenceShare);
  const provenance = `${comparison.source} · ${comparison.year}`;
  if (comparison.measuredShare === null || comparison.differencePercentagePoints === null) {
    return `<p class="detail-note detail-note-warning reference-comparison">Referencia: ${escapeHtml(referencePct)} (${escapeHtml(provenance)}). Nincs értékelhető mérés az eltérés kiszámításához.</p>`;
  }
  const measuredPct = formatPercent(comparison.measuredShare);
  const delta = comparison.differencePercentagePoints;
  const roundedDelta = Math.round(Math.abs(delta) * 10) / 10;
  const direction = roundedDelta === 0 ? 'megegyezik a referenciával' : delta < 0 ? 'alacsonyabb' : 'magasabb';
  const arm = comparison.measurementArm === 'baseline' ? 'Kontrollkar' : 'Perszónaátlag';
  const difference = roundedDelta === 0
    ? direction
    : `${roundedDelta} százalékponttal ${direction}`;
  return `<p class="detail-note reference-comparison"><strong>${arm}: ${measuredPct}</strong> · referencia: ${escapeHtml(referencePct)} · ${difference}. Forrás: ${escapeHtml(provenance)}.</p>`;
}

/**
 * Suffix for a persona's divergence cell (issue #40 review CRITICAL).
 * `movesModel === false` is a genuinely decided "within noise" result — the
 * control arm's own noise floor was measured. `movesModel === null` HERE
 * (only reached once a real divergence number is already on screen, i.e. a
 * control arm exists) means the opposite: the noise floor could not be
 * measured — fewer than 2 surviving control-arm seed-groups — so the reader
 * must be told the number is real but not yet interpretable, never mistaken
 * for "within noise" and never for a plain, decided divergence.
 */
function divergenceSuffix(movesModel) {
  if (movesModel === false) return ' (zajszint)';
  if (movesModel === null) return ' (nem eldönthető — kevés kontroll-adat)';
  return '';
}

function renderPersonaBreakdown(question) {
  const byPersona = question.byPersona || {};
  const entries = Object.entries(byPersona);
  if (entries.length === 0) return '<p class="placeholder-inline">Nincs perszóna szintű adat.</p>';

  const multi = question.elicitationMode === 'multi_choice';
  const rows = entries.map(([personaId, info]) => {
    const dist = info.distribution || [];
    const total = dist.reduce((a, b) => a + b, 0);
    let topIdx = -1;
    let topVal = 0;
    dist.forEach((v, i) => { if (v > topVal) { topVal = v; topIdx = i; } });
    // An all-zero distribution means nothing was measured for this persona — naming
    // a "top answer" there would assert a result that was never observed.
    const measured = topIdx >= 0;
    const topOption = measured ? question.options[topIdx] : 'nincs értékelhető válasz';
    // Multi-select: the top option's own support, not its share of a 100% total.
    const topPct = !measured ? '—' : (multi ? Math.round(topVal * 100) : Math.round((topVal / total) * 100));
    return `
      <tr>
        <td>${escapeHtml(info.name || personaId)}</td>
        <td>${escapeHtml(topOption || '—')}</td>
        <td class="numeric">${topPct === '—' ? '—' : topPct + '%'}</td>
        <td class="numeric" title="${escapeHtml(info.movesModel === null && info.baselineDivergence != null ? TOOLTIPS.personaEffectUndecidable : TOOLTIPS.personaEffect)}">${
          info.baselineDivergence === null || info.baselineDivergence === undefined
            ? '—'
            : formatMetric(info.baselineDivergence) + divergenceSuffix(info.movesModel)
        }</td>
        <td class="numeric">${formatNumber(info.abstainCount || 0)}</td>
      </tr>
    `;
  }).join('');

  return `
    <table class="persona-breakdown-table">
      <thead>
        <tr>
          <th>Perszóna</th>
          <th title="${escapeHtml(TOOLTIPS.topAnswer)}">Top válasz</th>
          <th class="numeric" title="${escapeHtml(multi ? TOOLTIPS.support : TOOLTIPS.distribution)}">%</th>
          <th class="numeric" title="${escapeHtml(TOOLTIPS.personaEffect)}">Perszóna-hatás</th>
          <th class="numeric" title="${escapeHtml(TOOLTIPS.abstain)}">Tartózkodás</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

async function loadOverviewTab(runId) {
  const container = document.getElementById('overviewContent');
  container.innerHTML = '<p class="placeholder">Betöltés...</p>';
  try {
    const results = await apiCall('GET', `/api/runs/${runId}/results`);
    const questions = results.questions || [];

    const summary = `
      <div class="overview-summary">
        <span class="stat-chip" title="${escapeHtml(TOOLTIPS.totalResponses)}">Összes válasz: ${formatNumber(results.totalResponses || 0)}</span>
        <span class="stat-chip ${((results.invalidRate || 0) * 100) > 10 ? 'stat-chip-danger' : ''}" title="${escapeHtml(TOOLTIPS.invalidRate)}">Érvénytelen arány: ${formatMetric((results.invalidRate || 0) * 100)}%</span>
        <span class="stat-chip" title="${escapeHtml(TOOLTIPS.abstainRate)}">Tartózkodási arány: ${formatMetric((results.abstainRate || 0) * 100)}%</span>
        ${renderDuplicateNotice(results)}
      </div>
    `;

    if (questions.length === 0) {
      container.innerHTML = summary + '<p class="placeholder">Nincs eredmény.</p>';
      return;
    }

    container.innerHTML = summary + questions.map(q => `
      <div class="question-card">
        <div class="question-card-header">
          <h4>${escapeHtml(q.text)}</h4>
          <div class="metric-chips">${renderMetricChips(q)}</div>
        </div>
        <div class="option-bars">
          ${renderLegacyOnlyNotice(q) || renderOptionBars(q)}
        </div>
        ${renderReferenceComparison(q)}
        <details class="persona-breakdown-wrap">
          <summary>Perszóna szintű bontás</summary>
          ${renderBaselineOnlyNotice(q)}
          ${renderPersonaBreakdown(q)}
        </details>
      </div>
    `).join('');
  } catch (err) {
    container.innerHTML = `<p class="error-message">Eredmények betöltése sikertelen: ${escapeHtml(err.message)}</p>`;
  }
}

/** Stored answers are option indexes; show what the respondent actually picked. */
function answerText(response) {
  let options = [];
  try {
    options = JSON.parse(response.options_json || '[]');
  } catch {
    options = [];
  }
  return answerLabel(response.parsed_answer, options, response.elicitation_mode === 'multi_choice');
}

/**
 * A run keeps pointing at the exact versions that answered. Saying so matters:
 * without it, a researcher comparing this run to the current persona would be
 * comparing two different subjects without noticing.
 */
function renderStaleVersionNotice(stale) {
  if (!stale) return '';
  const parts = [];
  if (stale.questionnaire) parts.push(`a kérdőív: v${stale.questionnaire.used} → azóta v${stale.questionnaire.latest}`);
  (stale.personas || []).forEach(p => {
    parts.push(`${p.name}: v${p.version} → azóta v${p.latestVersion}`);
  });
  if (parts.length === 0) return '';
  return `<p class="detail-note detail-note-warning">Ez a futtatás egy korábbi állapotra vonatkozik — ${escapeHtml(parts.join('; '))}. A rögzített válaszok az akkori verziókhoz tartoznak, ezért érvényesek maradnak.</p>`;
}

async function loadResponsesTab(runId) {
  const tbody = document.getElementById('responsesTableBody');
  const cardsView = document.getElementById('responseCardsView');
  tbody.innerHTML = '<tr><td colspan="7" class="placeholder">Betöltés...</td></tr>';
  if (cardsView) cardsView.innerHTML = '<p class="placeholder">Betöltés...</p>';
  try {
    // Shared with the Inspector's persona lookup (public/provenance.js) and
    // reused on a view-mode flip so switching Elemző/Mérnök does not refetch.
    const runData = await fetchRunResponsesCached(runId, true);
    const responses = runData.responses || [];


    if (responses.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="placeholder">Nincs válasz.</td></tr>';
      if (cardsView) cardsView.innerHTML = '<p class="placeholder">Nincs válasz.</p>';
      return;
    }

    tbody.innerHTML = responses.map(r => {
      // Abstention is a VALID response (is_valid = 1), so it must be checked first —
      // otherwise a tartózkodás would show up as a plain ✓ and disappear from view.
      const validClass = r.abstained ? 'abstained-flag' : (r.is_valid ? 'valid-flag' : 'invalid-flag');
      const validText = r.abstained ? '—' : (r.is_valid ? '✓' : '✗');
      const validTitle = r.abstained ? TOOLTIPS.abstain : (r.is_valid ? TOOLTIPS.validFlag : TOOLTIPS.invalid);
      const dist = renderDistribution(r.parsed_distribution_json, r.elicitation_mode === 'multi_choice');
      const distHtml = typeof dist === 'string' ? dist : dist.outerHTML;

      return `
        <tr data-response-id="${escapeHtml(r.id)}" class="response-row" role="button" tabindex="0" title="Kattints a válasz provenienciájáért: a pontos prompt, a nyers kimenet és a kísérleti beállítások.">
          <td>${escapeHtml(r.persona_name)}</td>
          <td>${escapeHtml(r.question_text)}</td>
          <td>${escapeHtml(answerText(r))}</td>
          <td>${distHtml}</td>
          <td><span class="${validClass}" title="${escapeHtml(validTitle)}">${validText}</span></td>
          <td>${escapeHtml(r.seed != null ? String(r.seed) : '—')}</td>
          <td>${renderModelCell(r)}</td>
        </tr>
      `;
    }).join('');

    renderResponseCardsInto(cardsView, responses, runId);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="error-message">Válaszok betöltése sikertelen: ${escapeHtml(err.message)}</td></tr>`;
    if (cardsView) cardsView.innerHTML = `<p class="error-message">Válaszok betöltése sikertelen: ${escapeHtml(err.message)}</p>`;
  }
}

async function loadTranscriptTab(runId) {
  const container = document.getElementById('transcriptContent');
  container.innerHTML = '<p class="placeholder">Betöltés...</p>';
  try {
    const runData = await apiCall('GET', '/api/runs/' + runId);
    container.innerHTML = renderTranscript(runData.responses || []);
  } catch (err) {
    container.innerHTML = `<p class="error-message">Átirat betöltése sikertelen: ${escapeHtml(err.message)}</p>`;
  }
}

/** One row = one model call; the panel shows exactly what produced it. */
async function openProvenancePanel(runId, responseId) {
  const panel = document.getElementById('provenancePanel');
  const body = document.getElementById('provenanceBody');
  const title = document.getElementById('provenancePanelTitle');
  if (title) title.textContent = 'Válasz proveniencia';
  panel.style.display = 'block';
  body.innerHTML = '<p class="placeholder">Betöltés...</p>';
  try {
    const response = await apiCall(
      'GET',
      `/api/runs/${encodeURIComponent(runId)}/responses/${encodeURIComponent(responseId)}`
    );
    body.innerHTML = renderResponseProvenance(response);
  } catch (err) {
    body.innerHTML = `<p class="error-message">Proveniencia betöltése sikertelen: ${escapeHtml(err.message)}</p>`;
  }
}

document.getElementById('provenanceCloseBtn')?.addEventListener('click', closeProvenancePanel);

function wireProvenanceOpening(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const open = (target) => {
    const row = target.closest('[data-response-id]');
    if (row && state.currentRunId) void openProvenancePanel(state.currentRunId, row.dataset.responseId);
  };
  container.addEventListener('click', (e) => open(e.target));
  container.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (!e.target.closest('[data-response-id]')) return;
    e.preventDefault();
    open(e.target);
  });
}

['responsesTableBody', 'transcriptContent'].forEach(wireProvenanceOpening);

function closeProvenancePanel() {
  const panel = document.getElementById('provenancePanel');
  if (panel) panel.style.display = 'none';
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeProvenancePanel();
});

/**
 * Names the calibration profile the judge had in context when it wrote this
 * evaluation (issue #17 M3, docs/MODEL-CALIBRATION.md §4). Recorded on the
 * evaluation row at evaluation time, so a profile that has since gone stale is
 * still reported with the status it actually had THEN — never today's status.
 * Reuses model-card.js's calibrationStatusChip/labels: one vocabulary for
 * calibration status ("érvényes"/"elavult"/"hiányzik") across the app.
 *
 * Review MEDIUM #6: a bare status chip does not distinguish two different
 * profiles for the same model (different measurement date, cell count,
 * provider) — so a cited profile also names its measured stack and date, not
 * just its status. And a NULL model_profile_status (a row written before
 * issue #17 M3 ever ran) must never be shown as the factual "there was no
 * profile" — that is what the distinct 'missing' status means; NULL means the
 * question was never even asked for this row, which is a weaker, different claim.
 */
function renderEvaluationProfileNote(ev) {
  if (ev.model_profile_id) {
    const stackParts = [ev.model_profile_model_version, ev.model_profile_provider]
      .filter(Boolean)
      .map(escapeHtml);
    const detailParts = [...stackParts];
    if (ev.model_profile_measured_at) {
      detailParts.push('mérve: ' + escapeHtml(formatDateTime(ev.model_profile_measured_at)));
    }
    const detail = detailParts.length > 0 ? ` (${detailParts.join(', ')})` : '';
    return `<p class="detail-note">Kalibrációs profil a kiértékelés idején: ${calibrationStatusChip(ev.model_profile_status)}${detail}</p>`;
  }
  if (ev.model_profile_status === 'missing') {
    return `<p class="detail-note detail-note-warning">Nincs kalibrációs profil ehhez a modellhez. Az eredmények így önmagukban olvasandók; nem tudjuk megmondani, mennyi a modell alapértelmezett viselkedése és mennyi a perszóna hatása. A kalibrációs profil rögzítéséhez nyisd meg a Modellek fület.</p>`;
  }
  // model_profile_status is null/undefined: a pre-M3 row, where whether a
  // profile existed simply was not recorded — UNKNOWN, not a definite "none".
  return `<p class="detail-note detail-note-warning">Nem rögzítve, hogy volt-e kalibrációs profil ennél a korábbi kiértékelésnél — nincs kalibrációs kontextus, amihez a perszóna-eredményeket viszonyítani lehetne.</p>`;
}

function renderEvaluationCard(ev) {
  const created = formatDateTime(ev.created_at);
  return `
    <div class="evaluation-card">
      <div class="evaluation-card-header">
        <span class="evaluation-model" title="${escapeHtml(TOOLTIPS.evaluationModel)}">${escapeHtml(ev.model || '—')}</span>
        ${renderPartialEvaluationChip(ev)}
        <span class="evaluation-date">${escapeHtml(created)}</span>
      </div>
      ${renderEvaluationProfileNote(ev)}
      <div class="evaluation-content">${renderMarkdown(ev.content || '')}</div>
      <div class="evaluation-meta">
        <span class="stat-chip" title="${escapeHtml(TOOLTIPS.tokens)}">${formatNumber(ev.prompt_tokens || 0)} prompt token</span>
        <span class="stat-chip" title="${escapeHtml(TOOLTIPS.tokens)}">${formatNumber(ev.completion_tokens || 0)} completion token</span>
        <span class="stat-chip" title="${escapeHtml(TOOLTIPS.cost)}">${formatCost(ev.cost_usd || 0)} USD</span>
      </div>
    </div>
  `;
}

async function loadEvaluationTab(runId) {
  const container = document.getElementById('evaluationsList');
  container.innerHTML = '<p class="placeholder">Betöltés...</p>';
  document.getElementById('evaluateError').textContent = '';
  try {
    const evaluations = await apiCall('GET', `/api/runs/${runId}/evaluations`);
    const sorted = [...(evaluations || [])].sort((a, b) => {
      const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
      const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
      return tb - ta;
    });
    if (sorted.length === 0) {
      container.innerHTML = '<p class="placeholder">Még nincs kiértékelés.</p>';
      return;
    }
    container.innerHTML = sorted.map(renderEvaluationCard).join('');
  } catch (err) {
    container.innerHTML = `<p class="error-message">Kiértékelések betöltése sikertelen: ${escapeHtml(err.message)}</p>`;
  }
}

document.getElementById('runEvaluateBtn')?.addEventListener('click', async () => {
  if (!state.currentRunId) return;
  const btn = document.getElementById('runEvaluateBtn');
  const spinner = document.getElementById('evaluateSpinner');
  const errorEl = document.getElementById('evaluateError');
  errorEl.textContent = '';
  btn.disabled = true;
  spinner.style.display = 'inline-block';
  try {
    await apiCall('POST', `/api/runs/${state.currentRunId}/evaluate`);
    await loadEvaluationTab(state.currentRunId);
    // Blocker #3: a manual evaluation books real spend (src/server.ts's
    // runEvaluation) that the run's card (token/cost chips) and the global
    // budget widget must reflect right away — not just on the next unrelated
    // action or an SSE round trip. The server now also emits 'status' for
    // this (belt-and-suspenders: covers a disconnected/reconnecting SSE
    // stream too), but this click already knows the evaluation is done the
    // moment the POST above resolves, so it does not need to wait for that.
    await refreshRunDetailHeader(state.currentRunId);
    await refreshRunsList();
    updateBudgetBar();
  } catch (err) {
    errorEl.textContent = 'Kiértékelés indítása sikertelen: ' + err.message;
  } finally {
    btn.disabled = false;
    spinner.style.display = 'none';
  }
});

// ----- Analyst/Engineer (X-Ray) toggle + response cards -----
// docs/UI-DESIGN.md §0/§3: a single global view mode (state.viewMode, app.js),
// a segmented pill in the run detail header (#viewModeToggle, index.html),
// and — for now — one consumer: the Válaszok subtab's response-card list
// below. The Áttekintés tab's aggregate charts are "clean result, no
// machinery" by construction already, so the toggle has no separate effect
// there; the pinned #responsesTableBody table is unaffected either way (see
// loadResponsesTab above and the display:none on .responses-table-wrapper).

document.getElementById('viewModeToggle')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.view-mode-btn');
  if (!btn || !btn.dataset.viewMode) return;
  setViewMode(btn.dataset.viewMode);
});

function setViewMode(mode) {
  if (mode !== 'analyst' && mode !== 'engineer') return;
  state.viewMode = mode;
  document.querySelectorAll('.view-mode-btn').forEach((b) => {
    const active = b.dataset.viewMode === mode;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  // Re-render so flipping the toggle takes effect immediately rather than on
  // the next subtab visit. The cache is preferred (no network round-trip), but
  // it is NOT a precondition: it can belong to a previously opened run, and
  // silently skipping the re-render in that case left Mérnök mode looking
  // identical to Elemző — the toggle moved, nothing else did.
  const cardsView = document.getElementById('responseCardsView');
  if (!cardsView || !state.currentRunId) return;
  if (state.runResponsesCache && state.runResponsesCache.runId === state.currentRunId) {
    renderResponseCardsInto(cardsView, state.runResponsesCache.data.responses || [], state.currentRunId);
  } else if (state.currentSubtab === 'responses') {
    void loadResponsesTab(state.currentRunId);
  }
}

/**
 * The run's `GET /api/runs/:id` payload (run + all responses), shared by the
 * response-card list, the Inspector's persona lookup and (indirectly) the
 * legacy responses table — one fetch per run, not one per consumer.
 * `force` re-fetches even if a cache for this exact run already exists,
 * which loadResponsesTab uses since it is the one place that must reflect a
 * freshly-completed/edited run rather than a possibly-stale earlier visit.
 */
async function fetchRunResponsesCached(runId, force) {
  if (!force && state.runResponsesCache && state.runResponsesCache.runId === runId) {
    return state.runResponsesCache.data;
  }
  const data = await apiCall('GET', '/api/runs/' + runId);
  state.runResponsesCache = { runId, data };
  return data;
}

/** GET /api/personas/:id, cached — the same persona is read by both a
 *  response card's version chip and the Inspector's Persona Provenance Card. */
async function fetchPersonaCached(personaId) {
  if (!personaId) return null;
  if (state.personaCache[personaId]) return state.personaCache[personaId];
  const persona = await apiCall('GET', '/api/personas/' + encodeURIComponent(personaId));
  state.personaCache[personaId] = persona;
  return persona;
}

/** Avatar glyph: the first letter of each of the first two words in the
 *  persona's name (e.g. "Anna Kovács" → "AK"). A purely cosmetic initials
 *  guess — comma-joined descriptive names ("Béla, a szkeptikus...") can
 *  pick up a short connector word as the second letter; that is a cosmetic
 *  quirk, not a data-accuracy concern, since nothing downstream reads it. */
function personaInitials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0][0] || '';
  const second = words.length > 1 ? (words[1][0] || '') : (words[0][1] || '');
  return (first + second).toUpperCase();
}

/** Always true for this platform (CLAUDE.md's methodology rules #1/#3) — a
 *  constant, not a per-response measurement, so it is safe to state plainly. */
function questionModeMeta(elicitationMode) {
  const multi = elicitationMode === 'multi_choice';
  return `Mód: Style C (eloszlás) • ${multi ? 'Többválaszos' : 'Egyválaszos'} • Memóriatörlés: aktív`;
}

function groupResponsesByQuestion(responses) {
  const order = [];
  const map = new Map();
  responses.forEach((r) => {
    const key = r.question_id || r.question_text || '—';
    if (!map.has(key)) {
      map.set(key, { text: r.question_text, elicitationMode: r.elicitation_mode, items: [] });
      order.push(key);
    }
    map.get(key).items.push(r);
  });
  return order.map((k) => map.get(k));
}

/**
 * The response's own distribution as one row per option (issue #46 final
 * mockup, docs/mockups/inspector-final.png): a light track spans the full
 * card width, a filled portion shows the option's own share, and the option
 * name + rounded percentage sit inside the track as one label. Row ORDER
 * stays the original option order, so the layout never leaks which position
 * in the permutation was largest — only the fill's SHADE is picked by rank
 * (largest share, second, rest).
 */
function renderResponseDistributionBar(parsedJson, isMultiChoice, optionsJson) {
  if (!parsedJson) return '<p class="placeholder-inline">Nincs eloszlás-adat.</p>';
  let data;
  try {
    data = typeof parsedJson === 'string' ? JSON.parse(parsedJson) : parsedJson;
  } catch (e) {
    return '<p class="placeholder-inline">Nincs eloszlás-adat.</p>';
  }
  if (!data || typeof data !== 'object') return '<p class="placeholder-inline">Nincs eloszlás-adat.</p>';
  const entries = Object.entries(data);
  if (entries.length === 0) return '<p class="placeholder-inline">Nincs eloszlás-adat.</p>';
  const total = entries.reduce((sum, [, v]) => sum + v, 0);
  if (!isMultiChoice && total === 0) return '<p class="placeholder-inline">Nincs eloszlás-adat.</p>';
  if (isMultiChoice && total === 0) return '<p class="placeholder-inline">Egyik sem.</p>';

  const ranked = [...entries].sort((a, b) => b[1] - a[1]);
  const tierByKey = new Map();
  ranked.forEach(([key], i) => {
    tierByKey.set(key, i === 0 ? 'dist-fill-1' : i === 1 ? 'dist-fill-2' : 'dist-fill-3');
  });

  // The distribution is keyed by option INDEX ("0", "1", …). Showing that index
  // as the label is meaningless to a reader — the mockup shows the option's own
  // wording inside the bar. Fall back to the raw key only if the option list is
  // missing, so a data gap stays visible instead of silently blank.
  let optionLabels = [];
  try {
    optionLabels = optionsJson ? (typeof optionsJson === 'string' ? JSON.parse(optionsJson) : optionsJson) : [];
  } catch (e) {
    optionLabels = [];
  }
  const labelFor = (key) => {
    const idx = Number(key);
    const named = Number.isInteger(idx) && Array.isArray(optionLabels) ? optionLabels[idx] : undefined;
    return typeof named === 'string' && named.length > 0 ? named : key;
  };

  const rows = entries
    .map(([key, value]) => {
      const pct = Math.round((isMultiChoice ? value : total > 0 ? value / total : 0) * 100);
      const tierClass = tierByKey.get(key);
      return `
        <div class="dist-row">
          <div class="dist-track">
            <div class="dist-fill ${tierClass}" style="width: ${pct}%"></div>
            <span class="dist-label">${escapeHtml(labelFor(key))} (${pct}%)</span>
          </div>
        </div>
      `;
    })
    .join('');
  return `<div class="dist-rows" title="${escapeHtml(isMultiChoice ? TOOLTIPS.support : TOOLTIPS.distribution)}">${rows}</div>`;
}

function renderXrayShell(responseId) {
  return `<div class="response-card-xray" data-xray-for="${escapeHtml(responseId)}"><p class="placeholder-inline" style="color:#94a3b8;">Betöltés...</p></div>`;
}

/** Engineer mode's per-card block: the SAME data as the Response Provenance
 *  panel (public/provenance.js), reused rather than re-derived. */
function renderXrayContent(r) {
  let permutation = [];
  try {
    permutation = r.permutation_json ? JSON.parse(r.permutation_json) : [];
  } catch (e) {
    permutation = [];
  }
  let options = [];
  try {
    options = r.options_json ? JSON.parse(r.options_json) : [];
  } catch (e) {
    options = [];
  }
  const permutationText = decodePermutation(permutation, options);
  return `
    <div class="response-card-xray-grid">
      <div><span class="rc-xray-label">Modell:</span> ${escapeHtml(r.model_version || r.model_requested || '—')}</div>
      <div><span class="rc-xray-label">Hőmérséklet:</span> ${escapeHtml(r.temperature === null || r.temperature === undefined ? '—' : r.temperature)}</div>
      <div><span class="rc-xray-label">Tokenek:</span> ${escapeHtml(orDash(r.prompt_tokens, formatNumber))} in / ${escapeHtml(orDash(r.completion_tokens, formatNumber))} out</div>
      <div><span class="rc-xray-label">Permutáció:</span> ${escapeHtml(permutationText)}</div>
      <div><span class="rc-xray-label">Seed:</span> ${escapeHtml(r.seed === null || r.seed === undefined ? '—' : r.seed)}</div>
      <div><span class="rc-xray-label">Szolgáltató:</span> ${escapeHtml(r.provider || '—')}</div>
    </div>
    <div class="response-card-xray-section-label">A modellnek elküldött prompt:</div>
    <div class="response-card-xray-code">${escapeHtml(r.prompt_rendered || 'Nincs rögzített prompt.')}</div>
    <div class="response-card-xray-section-label" style="margin-top:12px;">Nyers modellválasz:</div>
    <div class="response-card-xray-code">${escapeHtml(r.raw_response || 'Nincs rögzített nyers válasz.')}</div>
  `;
}

function renderResponseCard(resp, viewMode) {
  const name = resp.persona_name || '—';
  const isGap = !!resp.abstained;
  const xrayShell = viewMode === 'engineer' ? renderXrayShell(resp.id) : '';

  if (isGap) {
    // Evidentiary gap card (docs/UI-DESIGN.md §0/§6): amber, 4px left border,
    // white warning glyph instead of an avatar, a "Tartózkodás" chip — never
    // a red error. The measured reason (abstain/invalid counts, calibration
    // profile) lives in the Inspector, opened by clicking the card.
    return `
      <div class="response-card response-card-gap" data-response-id="${escapeHtml(resp.id)}" data-persona-id="${escapeHtml(resp.persona_id || '')}" role="button" tabindex="0" title="Kattints a perszóna provenienciájáért és a tartózkodás okáért.">
        <div class="response-card-body">
          <div class="response-card-gap-icon" aria-hidden="true">△</div>
          <div class="response-card-main">
            <div class="response-card-head">
              <span class="response-card-name">${escapeHtml(name)}</span>
              <span class="gap-chip">Tartózkodás</span>
            </div>
            <p class="response-card-gap-text">A perszóna tudáshatárt jelzett ehhez a kérdéshez — ez a lefedettségről szóló megállapítás, nem hiba. A mért ok a jobb oldali panelen (kattints a kártyára).</p>
          </div>
        </div>
        ${xrayShell}
      </div>
    `;
  }

  const multi = resp.elicitation_mode === 'multi_choice';
  const isInvalid = resp.is_valid === 0;
  const bodyContent = isInvalid
    ? `<p class="placeholder-inline" title="${escapeHtml(TOOLTIPS.invalid)}">✗ Nem értelmezhető modellkimenet.</p>`
    : renderResponseDistributionBar(resp.parsed_distribution_json, multi, resp.options_json);

  return `
    <div class="response-card" data-response-id="${escapeHtml(resp.id)}" data-persona-id="${escapeHtml(resp.persona_id || '')}" role="button" tabindex="0" title="Kattints a perszóna provenienciájáért.">
      <div class="response-card-body">
        <div class="response-avatar" aria-hidden="true">${escapeHtml(personaInitials(name))}</div>
        <div class="response-card-main">
          <div class="response-card-head">
            <span class="response-card-name">${escapeHtml(name)}</span>
            <span class="version-chip" data-version-for="${escapeHtml(resp.persona_id || '')}">…</span>
          </div>
          ${bodyContent}
        </div>
      </div>
      ${xrayShell}
    </div>
  `;
}

function renderResponseCardsView(responses, viewMode) {
  if (!responses || responses.length === 0) {
    return '<p class="placeholder">Nincs válasz.</p>';
  }
  const groups = groupResponsesByQuestion(responses);
  return groups
    .map(
      (g) => `
    <div class="rc-question-block">
      <h2 class="rc-question-title">${escapeHtml(g.text || '—')}</h2>
      <p class="rc-question-meta">${escapeHtml(questionModeMeta(g.elicitationMode))}</p>
      <div class="rc-card-list">
        ${g.items.map((r) => renderResponseCard(r, viewMode)).join('')}
      </div>
    </div>
  `
    )
    .join('');
}

/** Runs `worker` over `items` with at most `limit` in flight at once — used
 *  so switching to Engineer mode on a run with many responses does not fire
 *  one HTTP request per card simultaneously. */
async function runWithConcurrency(items, limit, worker) {
  let i = 0;
  async function next() {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
}

function renderResponseCardsInto(container, responses, runId) {
  if (!container) return;
  const viewMode = state.viewMode || 'analyst';
  container.innerHTML = renderResponseCardsView(responses, viewMode);
  wirePersonaCardOpening(container, runId);
  void fillVersionChips(container);
  if (viewMode === 'engineer') void fillXrayBlocks(container, responses, runId);
}

/** Each card's version chip needs the persona's OWN version (not the
 *  project's current one — issue-#46-adjacent staleness concern already
 *  documented elsewhere in this file: a response can point at a superseded
 *  persona version). Fetched lazily, once per unique persona, and patched in
 *  — never fabricated synchronously. */
async function fillVersionChips(container) {
  const chips = [...container.querySelectorAll('.version-chip[data-version-for]')];
  const personaIds = [...new Set(chips.map((c) => c.dataset.versionFor).filter(Boolean))];
  await runWithConcurrency(personaIds, 4, async (personaId) => {
    try {
      const persona = await fetchPersonaCached(personaId);
      const label = persona && persona.version ? 'v' + persona.version : '—';
      container.querySelectorAll(`.version-chip[data-version-for="${CSS.escape(personaId)}"]`).forEach((el) => {
        el.textContent = label;
      });
    } catch (e) {
      container.querySelectorAll(`.version-chip[data-version-for="${CSS.escape(personaId)}"]`).forEach((el) => {
        el.textContent = '—';
      });
    }
  });
}

/** Engineer mode fetches one request per card; a run can hold well over a
 *  thousand, so the automatic fill is capped and the rest is stated openly. */
const XRAY_AUTOLOAD_LIMIT = 30;

async function fillXrayBlocks(container, responses, runId) {
  const byId = new Map(responses.map((r) => [r.id, r]));
  const allShells = [...container.querySelectorAll('.response-card-xray[data-xray-for]')];
  // A large run has over a thousand response cards; firing one X-Ray request
  // per card froze a browser tab during review. Only a bounded first batch is
  // fetched automatically, and the rest SAYS so instead of sitting on
  // "Betöltés..." forever — a silent stall would read as a broken panel.
  const shells = allShells.slice(0, XRAY_AUTOLOAD_LIMIT);
  allShells.slice(XRAY_AUTOLOAD_LIMIT).forEach((shell) => {
    shell.innerHTML =
      `<p class="placeholder-inline" style="color:#94a3b8;">A gépezet-nézet az első ${XRAY_AUTOLOAD_LIMIT} válaszra töltődik be automatikusan. ` +
      `Ez a futtatás ${allShells.length} választ tartalmaz — a többi a válasz saját proveniencia-paneljén nézhető meg (kattints a kártyára).</p>`;
  });
  await runWithConcurrency(shells, 3, async (shell) => {
    const responseId = shell.dataset.xrayFor;
    try {
      const cached = state.responseXrayCache[responseId];
      const full = cached || (await apiCall('GET', `/api/runs/${encodeURIComponent(runId)}/responses/${encodeURIComponent(responseId)}`));
      state.responseXrayCache[responseId] = full;
      shell.innerHTML = renderXrayContent(full);
    } catch (err) {
      shell.innerHTML = `<p class="error-message">X-Ray adat betöltése sikertelen: ${escapeHtml(err.message)}</p>`;
    }
    // The row this card's own list already carries (r.prompt_tokens etc.) is
    // NOT enough — prompt_rendered/raw_response/permutation are deliberately
    // excluded from the bulk fetch (src/server.ts's comment on the single-
    // response endpoint), so this per-card request is the only source.
    void byId; // documents the map's purpose; not otherwise needed here.
  });
}

/**
 * A response card opens the Inspector's Persona Provenance Card (docs/
 * UI-DESIGN.md §"Becsúszó Inspector") — NOT the raw response provenance,
 * which Engineer mode now shows inline instead (renderXrayContent above).
 */
function wirePersonaCardOpening(container, runId) {
  const open = (target) => {
    const card = target.closest('[data-response-id]');
    if (card) void openPersonaProvenancePanel(runId, card.dataset.personaId, card.dataset.responseId);
  };
  container.addEventListener('click', (e) => {
    // The Engineer-mode X-Ray block is informational, not a persona-card
    // trigger — a click inside it must not also open the Inspector.
    if (e.target.closest('.response-card-xray')) return;
    open(e.target);
  });
  container.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (e.target.closest('.response-card-xray')) return;
    if (!e.target.closest('[data-response-id]')) return;
    e.preventDefault();
    open(e.target);
  });
}
