// Run detail controller: header, subtabs (overview / responses / evaluation)
// and the manual evaluation trigger.

// ----- Run Detail View -----
function findRunById(runId) {
  return state.runs.find(r => r.id === runId);
}

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

  await refreshRunDetailHeader(runId);
  await loadSubtab(state.currentSubtab || 'overview');
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
  tbody.innerHTML = '<tr><td colspan="7" class="placeholder">Betöltés...</td></tr>';
  try {
    const runData = await apiCall('GET', '/api/runs/' + runId);
    const responses = runData.responses || [];


    if (responses.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="placeholder">Nincs válasz.</td></tr>';
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
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="error-message">Válaszok betöltése sikertelen: ${escapeHtml(err.message)}</td></tr>`;
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

