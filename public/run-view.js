// Run detail controller: header, subtabs (overview / responses / evaluation)
// and the manual evaluation trigger.

// ----- Run Detail View -----
function findRunById(runId) {
  return state.runs.find(r => r.id === runId);
}

async function openRunDetail(runId, updateHash) {
  state.currentRunId = runId;
  closeEntityDetail(false); // one teardown path, so the two views cannot both be open
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
  setActiveTab('runs');
  refreshRunsList();
});

function renderRunDetailHeaderFromCache(runId) {
  const run = findRunById(runId);
  if (!run) return;
  const progress = state.runProgress[runId] || {};
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
      progress = state.runProgress[runId] || {};
    }
    renderRunDetailHeader(run, progress);
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
  document.querySelectorAll('.subtab-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`.subtab-btn[data-subtab="${name}"]`)?.classList.add('active');
  document.querySelectorAll('.subtab-pane').forEach(p => p.classList.remove('active'));
  document.getElementById('subtab-' + name)?.classList.add('active');

  if (!state.currentRunId) return;

  if (name === 'overview') {
    await loadOverviewTab(state.currentRunId);
  } else if (name === 'responses') {
    await loadResponsesTab(state.currentRunId);
  } else if (name === 'evaluation') {
    await loadEvaluationTab(state.currentRunId);
  }
}

function renderOptionBars(question) {
  const options = question.options || [];
  const aggregated = question.aggregated || [];
  const multi = question.elicitationMode === 'multi_choice';
  const total = aggregated.reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...aggregated);
  // Multi-select values are independent supports, so they must NOT be shown as
  // a share of a 100% total — that is exactly the reading the fix removes.
  const rowTooltip = multi ? TOOLTIPS.support : TOOLTIPS.distribution;

  return options.map((opt, i) => {
    const value = aggregated[i] || 0;
    const barPct = (value / max) * 100;
    const pct = multi
      ? Math.round(value * 100)
      : (total > 0 ? Math.round((value / total) * 100) : 0);
    return `
      <div class="option-bar-row" title="${escapeHtml(rowTooltip)}">
        <span class="option-bar-label">${escapeHtml(opt)}</span>
        <div class="option-bar-track">
          <div class="option-bar-fill${multi ? ' option-bar-fill-support' : ''}" style="width: ${barPct}%"></div>
        </div>
        <span class="option-bar-pct">${pct}%${multi ? ' támogatottság' : ''} (${formatMetric(value)})</span>
      </div>
    `;
  }).join('');
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
  if (stale.questionnaire) parts.push('a kérdőívnek azóta újabb verziója készült');
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
    const staleNotice = document.getElementById('runStaleVersions');
    if (staleNotice) staleNotice.innerHTML = renderStaleVersionNotice(runData.staleVersions);

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
        <tr>
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

function renderEvaluationCard(ev) {
  const created = formatDateTime(ev.created_at);
  return `
    <div class="evaluation-card">
      <div class="evaluation-card-header">
        <span class="evaluation-model" title="${escapeHtml(TOOLTIPS.evaluationModel)}">${escapeHtml(ev.model || '—')}</span>
        ${renderPartialEvaluationChip(ev)}
        <span class="evaluation-date">${escapeHtml(created)}</span>
      </div>
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
  } catch (err) {
    errorEl.textContent = 'Kiértékelés indítása sikertelen: ' + err.message;
  } finally {
    btn.disabled = false;
    spinner.style.display = 'none';
  }
});

