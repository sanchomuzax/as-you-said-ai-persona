// State
let state = {
  authenticated: false,
  models: [],
  projects: [],
  selectedProjectId: null,
  personas: [],
  questionnaires: [],
  runs: [],
  runProgress: {},
  currentRunId: null,
  currentSubtab: 'overview',
  currentRunDetailData: null,
  eventSource: null,
  progressPollTimer: null,
  activeTab: 'projects'
};

const STATUS_LABELS = {
  pending: 'Függőben',
  running: 'Fut',
  paused: 'Szüneteltetve',
  completed: 'Kész',
  budget_exhausted: 'Keret elfogyott',
  stopped: 'Leállítva',
  failed: 'Hiba'
};

// API wrapper
async function apiCall(method, path, body = null) {
  // Content-Type only with an actual body: Fastify rejects an empty body that
  // declares application/json (FST_ERR_CTP_EMPTY_JSON_BODY).
  const options = { method };
  if (body) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }

  const response = await fetch(path, options);
  const data = await response.json();

  if (response.status === 401) {
    state.authenticated = false;
    showLoginScreen();
    throw new Error('Unauthorized');
  }

  if (!data.success && data.error) throw new Error(data.error);
  return data.data;
}

// Utility functions
function parseDemographics(text) {
  const demographics = {};
  text.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed) {
      const [key, value] = trimmed.split(':').map(s => s.trim());
      if (key && value) demographics[key] = value;
    }
  });
  return demographics;
}

function parseQuestions(text) {
  const questions = [];
  const blocks = text.split(/\n\s*\n/).filter(b => b.trim());

  blocks.forEach(block => {
    const lines = block.trim().split('\n');
    if (lines.length > 0) {
      const questionText = lines[0].trim();
      const options = lines.slice(1)
        .filter(l => l.trim().startsWith('- '))
        .map(l => l.trim().substring(2));

      if (questionText && options.length > 0) {
        questions.push({ text: questionText, options });
      }
    }
  });
  return questions;
}

function renderDistribution(parsed_json) {
  if (!parsed_json) return '—';
  try {
    const data = typeof parsed_json === 'string' ? JSON.parse(parsed_json) : parsed_json;
    if (!data || typeof data !== 'object') return '—';

    const total = Object.values(data).reduce((a, b) => a + b, 0);
    if (total === 0) return '—';

    const div = document.createElement('div');
    div.className = 'distribution-bar';

    Object.entries(data).forEach(([key, count]) => {
      const pct = Math.round((count / total) * 100);
      const seg = document.createElement('div');
      seg.className = 'distribution-segment';
      seg.textContent = pct + '%';
      seg.title = key + ': ' + count;
      seg.style.width = Math.max(pct * 2, 20) + 'px';
      div.appendChild(seg);
    });

    return div;
  } catch {
    return '—';
  }
}

function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatNumber(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '0';
  return Number(n).toLocaleString('hu-HU');
}

function formatCost(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '0.0000';
  return Number(n).toFixed(4);
}

function formatMetric(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return Number(n).toFixed(2);
}

// ----- Hash routing -----
function parseHash() {
  const hash = (location.hash || '').replace(/^#/, '');
  if (!hash) return { tab: 'projects', runId: null };
  const runMatch = hash.match(/^runs\/(.+)$/);
  if (runMatch) return { tab: 'runs', runId: runMatch[1] };
  const validTabs = ['projects', 'personas', 'questionnaires', 'runs'];
  if (validTabs.includes(hash)) return { tab: hash, runId: null };
  return { tab: 'projects', runId: null };
}

function setHash(tab, runId) {
  const newHash = runId ? '#runs/' + runId : '#' + tab;
  if (location.hash !== newHash) {
    history.replaceState(null, '', newHash);
  }
}

window.addEventListener('hashchange', () => {
  if (!state.authenticated) return;
  applyRoute(parseHash());
});

async function applyRoute(route) {
  if (route.runId) {
    state.activeTab = 'runs';
    setActiveTab('runs');
    await openRunDetail(route.runId, false);
  } else {
    closeRunDetail(false);
    state.activeTab = route.tab;
    setActiveTab(route.tab);
    setHash(route.tab, null);
  }
}

// DOM Functions
function showLoginScreen() {
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('appContainer').style.display = 'none';
  if (state.eventSource) state.eventSource.close();
  if (state.progressPollTimer) clearInterval(state.progressPollTimer);
}

function showAppScreen() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('appContainer').style.display = 'flex';
}

function setActiveTab(tabName) {
  document.getElementById('runDetailView').style.display = 'none';
  document.querySelector('.tab-content').style.display = 'block';
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));

  document.getElementById('tab-' + tabName)?.classList.add('active');
  document.querySelector('[data-tab="' + tabName + '"]')?.classList.add('active');
}

// List Rendering
function renderProjectsList() {
  const container = document.getElementById('projectsList');
  if (state.projects.length === 0) {
    container.innerHTML = '<p class="placeholder">Nincs projekt.</p>';
    return;
  }

  container.innerHTML = state.projects.map(p => {
    const metaParts = [];
    if (p.applicationDomain) metaParts.push(escapeHtml(p.applicationDomain));
    if (p.targetPopulation) metaParts.push(escapeHtml(p.targetPopulation));
    const metaStr = metaParts.join(' | ');

    return `
      <div class="list-item">
        <div>
          <div class="list-item-title">${escapeHtml(p.name)}</div>
          ${metaStr ? `<div class="list-item-meta">${metaStr}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function updateProjectDropdowns() {
  const selects = [
    document.getElementById('personaProjectSelect'),
    document.getElementById('runProjectSelect'),
    document.getElementById('questionnaireProjectSelect')
  ];

  selects.forEach(select => {
    if (!select) return;
    const currentValue = select.value;
    select.innerHTML = '<option value="">-- Válassz projektet --</option>';
    select.innerHTML += state.projects.map(p =>
      `<option value="${p.id}">${escapeHtml(p.name)}</option>`
    ).join('');
    select.value = currentValue;
  });
}

function selectProjectEverywhere(projectId) {
  state.selectedProjectId = projectId || null;
  if (projectId) {
    localStorage.setItem('selectedProjectId', projectId);
  } else {
    localStorage.removeItem('selectedProjectId');
  }
  ['personaProjectSelect', 'runProjectSelect', 'questionnaireProjectSelect'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = projectId || '';
  });
}

function updatePersonaFormVisibility() {
  const section = document.getElementById('personaFormSection');
  const hint = document.getElementById('noProjectHint');
  if (state.projects.length === 0) {
    section.style.display = 'none';
    hint.style.display = 'block';
  } else {
    section.style.display = 'block';
    hint.style.display = 'none';
  }
}

function renderPersonasList() {
  const container = document.getElementById('personasList');
  if (state.personas.length === 0) {
    container.innerHTML = '<p class="placeholder">Nincs perszóna.</p>';
    return;
  }

  container.innerHTML = state.personas.map(p => {
    const demStr = Object.entries(p.demographics || {})
      .map(([k, v]) => k + ': ' + v).join(', ');
    return `
      <div class="list-item">
        <div>
          <div class="list-item-title">${escapeHtml(p.name)}</div>
          <div class="list-item-meta">${escapeHtml(demStr)}</div>
        </div>
      </div>
    `;
  }).join('');
}

function renderQuestionnairesList() {
  const container = document.getElementById('questionnairesList');
  if (state.questionnaires.length === 0) {
    container.innerHTML = '<p class="placeholder">Nincs kérdőív.</p>';
    return;
  }

  container.innerHTML = state.questionnaires.map(q => {
    const qCount = (q.questions || []).length;
    let projectLabel = '(globális)';
    if (q.projectId) {
      const project = state.projects.find(p => p.id === q.projectId);
      projectLabel = project ? escapeHtml(project.name) : '(ismeretlen projekt)';
    }
    return `
      <div class="list-item">
        <div>
          <div class="list-item-title">${escapeHtml(q.name)}</div>
          <div class="list-item-meta">${qCount} kérdés | ${projectLabel}</div>
        </div>
      </div>
    `;
  }).join('');

  // Update run form questionnaire select
  const select = document.getElementById('runQuestionnaire');
  const currentValue = select.value;
  select.innerHTML = '<option value="">-- Válassz kérdőívet --</option>';
  select.innerHTML += state.questionnaires.map(q =>
    `<option value="${q.id}">${escapeHtml(q.name)}</option>`
  ).join('');
  select.value = currentValue;
}

// ----- Run cards / dashboard -----
function badgeClassForStatus(status) {
  return 'badge badge-' + (status || 'pending');
}

function statusLabel(status) {
  return STATUS_LABELS[status] || status || '—';
}

function runControlButtons(run, context) {
  const status = run.status;
  const buttons = [];
  if (status === 'running') {
    buttons.push(`<button class="btn btn-secondary btn-sm" data-action="pause" data-run="${run.id}">Szünet</button>`);
  }
  if (status === 'paused' || status === 'budget_exhausted' || status === 'failed') {
    buttons.push(`<button class="btn btn-secondary btn-sm" data-action="resume" data-run="${run.id}">Folytatás</button>`);
  }
  if (status === 'running' || status === 'paused') {
    buttons.push(`<button class="btn btn-danger btn-sm" data-action="stop" data-run="${run.id}">Leállítás</button>`);
  }
  if (context === 'card') {
    buttons.push(`<button class="btn btn-primary btn-sm" data-action="details" data-run="${run.id}">Részletek</button>`);
  }
  return buttons.join('');
}

function invalidPct(invalid, total) {
  if (!total) return 0;
  return (invalid / total) * 100;
}

function renderRunCard(run) {
  const progress = state.runProgress[run.id] || {};
  const totalCells = progress.totalCells ?? run.totalCells ?? 0;
  const done = progress.done ?? run.response_count ?? 0;
  const invalid = progress.invalid ?? run.invalid_count ?? 0;
  const abstained = progress.abstained ?? run.abstained_count ?? 0;
  const usage = progress.usage || {};
  const totalTokens = usage.totalTokens ?? run.total_tokens ?? 0;
  const costUsd = usage.costUsd ?? run.cost_usd ?? 0;
  const pct = totalCells > 0 ? Math.min((done / totalCells) * 100, 100) : 0;
  const invPct = invalidPct(invalid, totalCells);
  const status = progress.status || run.status;

  return `
    <div class="run-card" data-run-card="${run.id}">
      <div class="run-card-header">
        <div class="run-card-title">${escapeHtml(run.name)}</div>
        <span class="${badgeClassForStatus(status)}">
          ${status === 'running' ? '<span class="pulse-dot"></span>' : ''}${escapeHtml(statusLabel(status))}
        </span>
      </div>
      <div class="progress-bar">
        <div class="progress-fill" style="width: ${pct}%"></div>
      </div>
      <div class="run-card-stats">
        <span class="stat-chip">${formatNumber(done)}/${formatNumber(totalCells)} cella</span>
        <span class="stat-chip ${invPct > 10 ? 'stat-chip-danger' : ''}">Érvénytelen: ${formatNumber(invalid)}</span>
        <span class="stat-chip">Elutasítva: ${formatNumber(abstained)}</span>
        <span class="stat-chip">${formatNumber(totalTokens)} token</span>
        <span class="stat-chip">${formatCost(costUsd)} USD</span>
      </div>
      <div class="run-card-controls">
        ${runControlButtons(run, 'card')}
      </div>
    </div>
  `;
}

function renderRunsList() {
  const container = document.getElementById('runsList');
  if (state.runs.length === 0) {
    container.innerHTML = '<p class="placeholder">Nincs futtatás.</p>';
    return;
  }

  container.innerHTML = state.runs.map(r => renderRunCard(r)).join('');
}

document.getElementById('runsList')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const runId = btn.dataset.run;
  await handleRunAction(action, runId);
});

document.getElementById('runDetailControls')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const runId = btn.dataset.run;
  await handleRunAction(action, runId);
});

async function handleRunAction(action, runId) {
  try {
    if (action === 'details') {
      setHash('runs', runId);
      await openRunDetail(runId, true);
      return;
    }
    if (action === 'pause') {
      await apiCall('POST', `/api/runs/${runId}/pause`);
    } else if (action === 'resume') {
      await apiCall('POST', `/api/runs/${runId}/resume`);
    } else if (action === 'stop') {
      if (!confirm('Biztosan leállítod a futtatást? Ez a művelet nem visszavonható.')) return;
      await apiCall('POST', `/api/runs/${runId}/stop`);
    }
    await refreshRunsList();
    if (state.currentRunId === runId) {
      await refreshRunDetailHeader(runId);
    }
  } catch (err) {
    alert('Művelet sikertelen: ' + err.message);
  }
}

async function refreshRunsList() {
  try {
    const runs = await apiCall('GET', '/api/runs');
    state.runs = runs;
    renderRunsList();
    await pollRunningProgress(true);
  } catch (err) {
    // silent - keep last known state
  }
}

/**
 * Fetches progress for runs. Finished runs also need it once (cell totals, tokens,
 * cost are only available here) — without it their cards show 0 totals.
 */
async function pollRunningProgress(includeAll = false) {
  const targets = includeAll
    ? state.runs
    : state.runs.filter(r => r.status === 'running' || !state.runProgress[r.id]);
  if (targets.length === 0) return;
  await Promise.all(targets.map(async r => {
    try {
      const progress = await apiCall('GET', `/api/runs/${r.id}/progress`);
      state.runProgress[r.id] = progress;
    } catch {
      // ignore
    }
  }));
  renderRunsList();
  if (state.currentRunId && targets.some(r => r.id === state.currentRunId)) {
    renderRunDetailHeaderFromCache(state.currentRunId);
  }
}

function startProgressPolling() {
  if (state.progressPollTimer) clearInterval(state.progressPollTimer);
  state.progressPollTimer = setInterval(pollRunningProgress, 5000);
}

function renderPersonasCheckboxes() {
  const container = document.getElementById('runPersonas');
  if (state.personas.length === 0) {
    container.innerHTML = '<p class="placeholder">Nincs perszóna.</p>';
    return;
  }

  container.innerHTML = state.personas.map(p => `
    <div class="checkbox-item">
      <input type="checkbox" id="persona_${p.id}" value="${p.id}" name="personas">
      <label for="persona_${p.id}">${escapeHtml(p.name)}</label>
    </div>
  `).join('');
}

function updateBudgetBar() {
  apiCall('GET', '/api/budget')
    .then(data => {
      const used = data.global.totalTokens || 0;
      const limit = data.limits.globalBudget || 1;
      const pct = Math.min((used / limit) * 100, 100);

      document.getElementById('budgetTokens').textContent = used;
      document.getElementById('budgetLimit').textContent = limit;
      document.getElementById('budgetCost').textContent = (data.global.costUsd || 0).toFixed(4);
      document.getElementById('budgetProgress').style.width = pct + '%';
    })
    .catch(() => {
      document.getElementById('budgetTokens').textContent = '—';
      document.getElementById('budgetLimit').textContent = '—';
      document.getElementById('budgetCost').textContent = '—';
    });
}

// ----- Run Detail View -----
function findRunById(runId) {
  return state.runs.find(r => r.id === runId);
}

async function openRunDetail(runId, updateHash) {
  state.currentRunId = runId;
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
  statusEl.innerHTML = (status === 'running' ? '<span class="pulse-dot"></span>' : '') + escapeHtml(statusLabel(status));

  const totalCells = progress.totalCells ?? 0;
  const done = progress.done ?? 0;
  const invalid = progress.invalid ?? 0;
  const abstained = progress.abstained ?? 0;
  const usage = progress.usage || {};
  const pct = totalCells > 0 ? Math.min((done / totalCells) * 100, 100) : 0;
  const invPct = invalidPct(invalid, totalCells);

  document.getElementById('runDetailProgressFill').style.width = pct + '%';
  document.getElementById('runDetailStats').innerHTML = `
    <span class="stat-chip">${formatNumber(done)}/${formatNumber(totalCells)} cella</span>
    <span class="stat-chip ${invPct > 10 ? 'stat-chip-danger' : ''}">Érvénytelen: ${formatNumber(invalid)}</span>
    <span class="stat-chip">Elutasítva: ${formatNumber(abstained)}</span>
    <span class="stat-chip">${formatNumber(usage.totalTokens || 0)} token</span>
    <span class="stat-chip">${formatCost(usage.costUsd || 0)} USD</span>
    ${progress.avgLatencyMs ? `<span class="stat-chip">${formatNumber(Math.round(progress.avgLatencyMs))} ms/válasz</span>` : ''}
  `;
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
  const total = aggregated.reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...aggregated);

  return options.map((opt, i) => {
    const value = aggregated[i] || 0;
    const barPct = (value / max) * 100;
    const sharePct = total > 0 ? Math.round((value / total) * 100) : 0;
    return `
      <div class="option-bar-row">
        <span class="option-bar-label" title="${escapeHtml(opt)}">${escapeHtml(opt)}</span>
        <div class="option-bar-track">
          <div class="option-bar-fill" style="width: ${barPct}%"></div>
        </div>
        <span class="option-bar-pct">${sharePct}% (${formatNumber(value)})</span>
      </div>
    `;
  }).join('');
}

function renderPersonaBreakdown(question) {
  const byPersona = question.byPersona || {};
  const entries = Object.entries(byPersona);
  if (entries.length === 0) return '<p class="placeholder-inline">Nincs perszóna szintű adat.</p>';

  const rows = entries.map(([personaId, info]) => {
    const dist = info.distribution || [];
    const total = dist.reduce((a, b) => a + b, 0);
    let topIdx = -1;
    let topVal = -1;
    dist.forEach((v, i) => { if (v > topVal) { topVal = v; topIdx = i; } });
    const topOption = topIdx >= 0 && question.options ? question.options[topIdx] : '—';
    const topPct = total > 0 && topVal >= 0 ? Math.round((topVal / total) * 100) : 0;
    return `
      <tr>
        <td>${escapeHtml(info.name || personaId)}</td>
        <td>${escapeHtml(topOption || '—')}</td>
        <td class="numeric">${topPct}%</td>
        <td class="numeric">${formatNumber(info.abstainCount || 0)}</td>
      </tr>
    `;
  }).join('');

  return `
    <table class="persona-breakdown-table">
      <thead>
        <tr>
          <th>Perszóna</th>
          <th>Top válasz</th>
          <th class="numeric">%</th>
          <th class="numeric">Elutasítás</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderMetricChips(question) {
  const chips = [];
  const pc = question.positionConsistency;
  const rs = question.repetitionStability;
  if (pc !== undefined && pc !== null) {
    chips.push(`<span class="metric-chip">PC ${formatMetric(pc)}</span>`);
    if (pc < 0.7) chips.push('<span class="metric-chip metric-chip-warning">⚠ pozíció-érzékeny — nem megbízható</span>');
  }
  if (rs !== undefined && rs !== null) {
    chips.push(`<span class="metric-chip">RS ${formatMetric(rs)}</span>`);
    if (rs < 0.7) chips.push('<span class="metric-chip metric-chip-warning">⚠ instabil</span>');
  }
  chips.push(`<span class="metric-chip metric-chip-info">🔍 bizonyítékhézag: ${formatNumber(question.abstainCount || 0)}</span>`);
  if (question.invalidCount) {
    chips.push(`<span class="metric-chip metric-chip-danger">Érvénytelen: ${formatNumber(question.invalidCount)}</span>`);
  }
  return chips.join('');
}

async function loadOverviewTab(runId) {
  const container = document.getElementById('overviewContent');
  container.innerHTML = '<p class="placeholder">Betöltés...</p>';
  try {
    const results = await apiCall('GET', `/api/runs/${runId}/results`);
    const questions = results.questions || [];

    const summary = `
      <div class="overview-summary">
        <span class="stat-chip">Összes válasz: ${formatNumber(results.totalResponses || 0)}</span>
        <span class="stat-chip ${((results.invalidRate || 0) * 100) > 10 ? 'stat-chip-danger' : ''}">Érvénytelen arány: ${formatMetric((results.invalidRate || 0) * 100)}%</span>
        <span class="stat-chip">Elutasítási arány: ${formatMetric((results.abstainRate || 0) * 100)}%</span>
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
          ${renderOptionBars(q)}
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
      const validClass = r.is_valid ? 'valid-flag' : (r.abstained ? 'abstained-flag' : 'invalid-flag');
      const validText = r.is_valid ? '✓' : (r.abstained ? '—' : '✗');
      const dist = renderDistribution(r.parsed_distribution_json);
      const distHtml = typeof dist === 'string' ? dist : dist.outerHTML;

      return `
        <tr>
          <td>${escapeHtml(r.persona_name)}</td>
          <td>${escapeHtml(r.question_text)}</td>
          <td>${escapeHtml(r.parsed_answer || '—')}</td>
          <td>${distHtml}</td>
          <td><span class="${validClass}">${validText}</span></td>
          <td>${escapeHtml(r.seed != null ? String(r.seed) : '—')}</td>
          <td>${escapeHtml(r.model_version || '—')}</td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="error-message">Válaszok betöltése sikertelen: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderEvaluationCard(ev) {
  const created = ev.created_at ? new Date(ev.created_at).toLocaleString('hu-HU') : '—';
  return `
    <div class="evaluation-card">
      <div class="evaluation-card-header">
        <span class="evaluation-model">${escapeHtml(ev.model || '—')}</span>
        <span class="evaluation-date">${escapeHtml(created)}</span>
      </div>
      <pre class="evaluation-content">${escapeHtml(ev.content || '')}</pre>
      <div class="evaluation-meta">
        <span class="stat-chip">${formatNumber(ev.prompt_tokens || 0)} prompt token</span>
        <span class="stat-chip">${formatNumber(ev.completion_tokens || 0)} completion token</span>
        <span class="stat-chip">${formatCost(ev.cost_usd || 0)} USD</span>
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

// Event Subscription
function subscribeToEvents() {
  if (state.eventSource) state.eventSource.close();

  state.eventSource = new EventSource('/api/events');

  state.eventSource.addEventListener('response', (e) => {
    const evt = JSON.parse(e.data);
    if (state.currentRunId === evt.runId) {
      refreshRunDetailHeader(evt.runId);
      if (state.currentSubtab === 'responses') loadResponsesTab(evt.runId);
      if (state.currentSubtab === 'overview') loadOverviewTab(evt.runId);
    }
  });

  state.eventSource.addEventListener('status', (e) => {
    const evt = JSON.parse(e.data);
    refreshRunsList();
    if (state.currentRunId === evt.runId) {
      refreshRunDetailHeader(evt.runId);
    }
  });

  state.eventSource.addEventListener('evaluation', (e) => {
    const evt = JSON.parse(e.data);
    if (state.currentRunId === evt.runId && state.currentSubtab === 'evaluation') {
      loadEvaluationTab(evt.runId);
    }
  });

  state.eventSource.onerror = () => {
    state.eventSource.close();
    setTimeout(subscribeToEvents, 3000);
  };
}

// Form Handlers
document.getElementById('projectForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const body = {
      name: document.getElementById('projectName').value,
      applicationDomain: document.getElementById('projectApplicationDomain').value || undefined,
      targetPopulation: document.getElementById('projectTargetPopulation').value || undefined
    };
    const newProject = await apiCall('POST', '/api/projects', body);
    document.getElementById('projectForm').reset();
    const projects = await apiCall('GET', '/api/projects');
    state.projects = projects;
    renderProjectsList();
    updateProjectDropdowns();
    updatePersonaFormVisibility();
    selectProjectEverywhere(newProject.id);
    const submitBtn = document.getElementById('personaSubmitBtn');
    if (submitBtn) submitBtn.disabled = false;
    await reloadPersonasList();
    await reloadQuestionnairesList(newProject.id);
  } catch (err) {
    alert('Projekt létrehozása sikertelen: ' + err.message);
  }
});

document.getElementById('personaProjectSelect')?.addEventListener('change', async (e) => {
  const projectId = e.target.value;
  selectProjectEverywhere(projectId);
  const submitBtn = document.getElementById('personaSubmitBtn');
  if (submitBtn) submitBtn.disabled = !projectId;
  if (projectId) {
    await reloadPersonasList();
  } else {
    state.personas = [];
    renderPersonasList();
    renderPersonasCheckboxes();
  }
});

document.getElementById('runProjectSelect')?.addEventListener('change', async (e) => {
  const projectId = e.target.value;
  selectProjectEverywhere(projectId);
  if (projectId) {
    await reloadPersonasList();
    await reloadQuestionnairesList(projectId);
  } else {
    state.personas = [];
    renderPersonasCheckboxes();
    state.questionnaires = [];
    renderQuestionnairesList();
  }
});

document.getElementById('questionnaireProjectSelect')?.addEventListener('change', async (e) => {
  const projectId = e.target.value;
  selectProjectEverywhere(projectId);
  if (projectId) {
    await reloadQuestionnairesList(projectId);
  } else {
    state.questionnaires = [];
    renderQuestionnairesList();
  }
});

async function reloadPersonasList() {
  try {
    const url = state.selectedProjectId
      ? `/api/personas?project=${state.selectedProjectId}`
      : '/api/personas';
    const personas = await apiCall('GET', url);
    state.personas = personas;
    renderPersonasList();
    renderPersonasCheckboxes();
  } catch (err) {
    alert('Perszónák betöltése sikertelen: ' + err.message);
  }
}

async function reloadQuestionnairesList(projectId) {
  try {
    const url = projectId
      ? `/api/questionnaires?project=${projectId}`
      : '/api/questionnaires';
    const questionnaires = await apiCall('GET', url);
    state.questionnaires = questionnaires;
    renderQuestionnairesList();
  } catch (err) {
    alert('Kérdőívek betöltése sikertelen: ' + err.message);
  }
}

document.getElementById('loginForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;

  try {
    await apiCall('POST', '/api/login', { username, password });
    state.authenticated = true;
    document.getElementById('username').value = '';
    document.getElementById('password').value = '';
    document.getElementById('loginError').textContent = '';
    showAppScreen();
    await loadInitialData();
  } catch (err) {
    document.getElementById('loginError').textContent = err.message || 'Bejelentkezés sikertelen';
  }
});

document.getElementById('logoutBtn')?.addEventListener('click', async () => {
  try {
    await apiCall('POST', '/api/logout');
  } catch {}
  state.authenticated = false;
  showLoginScreen();
});

document.getElementById('personaForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    if (!state.selectedProjectId) {
      alert('Válassz projektet!');
      return;
    }
    const body = {
      name: document.getElementById('personaName').value,
      demographics: parseDemographics(document.getElementById('personaDemographics').value),
      biography: document.getElementById('personaBiography').value || undefined,
      renderingStyle: document.getElementById('personaStyle').value,
      projectId: state.selectedProjectId
    };
    await apiCall('POST', '/api/personas', body);
    document.getElementById('personaForm').reset();
    await reloadPersonasList();
  } catch (err) {
    alert('Perszóna létrehozása sikertelen: ' + err.message);
  }
});

document.getElementById('questionnaireForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const questions = parseQuestions(document.getElementById('questionsText').value);
    const projectId = document.getElementById('questionnaireProjectSelect').value;
    const body = {
      name: document.getElementById('questionnaireName').value,
      questions
    };
    if (projectId) {
      body.projectId = projectId;
    }
    await apiCall('POST', '/api/questionnaires', body);
    document.getElementById('questionnaireForm').reset();
    const url = projectId ? `/api/questionnaires?project=${projectId}` : '/api/questionnaires';
    const questionnaires = await apiCall('GET', url);
    state.questionnaires = questionnaires;
    renderQuestionnairesList();
  } catch (err) {
    alert('Kérdőív létrehozása sikertelen: ' + err.message);
  }
});

document.getElementById('runForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    if (!state.selectedProjectId) {
      alert('Válassz projektet!');
      return;
    }
    const personaIds = Array.from(
      document.querySelectorAll('#runPersonas input[type="checkbox"]:checked')
    ).map(cb => cb.value);

    const body = {
      name: document.getElementById('runName').value,
      questionnaireId: document.getElementById('runQuestionnaire').value,
      personaIds,
      model: document.getElementById('runModel').value,
      temperature: parseFloat(document.getElementById('runTemperature').value),
      projectId: state.selectedProjectId,
      autoEvaluate: document.getElementById('runAutoEvaluate').checked
    };

    await apiCall('POST', '/api/runs', body);
    document.getElementById('runForm').reset();
    await refreshRunsList();
    updateBudgetBar();
  } catch (err) {
    alert('Futtatás indítása sikertelen: ' + err.message);
  }
});

// Tab Navigation
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tabName = btn.dataset.tab;
    state.activeTab = tabName;
    closeRunDetail(false);
    setActiveTab(tabName);
    setHash(tabName, null);
  });
});

// Initial Load
async function loadInitialData() {
  try {
    const [models, projects, personas, questionnaires, runs] = await Promise.all([
      apiCall('GET', '/api/models'),
      apiCall('GET', '/api/projects'),
      apiCall('GET', '/api/personas'),
      apiCall('GET', '/api/questionnaires'),
      apiCall('GET', '/api/runs')
    ]);

    state.models = models.models || [];
    state.projects = projects;
    state.personas = personas;
    state.questionnaires = questionnaires;
    state.runs = runs;

    renderProjectsList();
    updateProjectDropdowns();
    updatePersonaFormVisibility();
    renderQuestionnairesList();
    renderRunsList();
    updateBudgetBar();

    const personaSubmitBtn = document.getElementById('personaSubmitBtn');
    if (personaSubmitBtn) personaSubmitBtn.disabled = true;

    const modelSelect = document.getElementById('runModel');
    modelSelect.innerHTML = state.models.map(m =>
      `<option value="${m.id}" ${m.id === models.default ? 'selected' : ''}>${escapeHtml(m.label)}</option>`
    ).join('');

    // Restore selected project from localStorage
    const storedProjectId = localStorage.getItem('selectedProjectId');
    if (storedProjectId && state.projects.some(p => p.id === storedProjectId)) {
      selectProjectEverywhere(storedProjectId);
      const personaSubmitBtn2 = document.getElementById('personaSubmitBtn');
      if (personaSubmitBtn2) personaSubmitBtn2.disabled = false;
      await reloadPersonasList();
      await reloadQuestionnairesList(storedProjectId);
    } else {
      renderPersonasList();
      renderPersonasCheckboxes();
    }

    subscribeToEvents();
    startProgressPolling();

    // Restore route from hash (tab / open run detail)
    await applyRoute(parseHash());
  } catch (err) {
    alert('Adatbetöltés sikertelen: ' + err.message);
  }
}

// Check session on page load
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const session = await apiCall('GET', '/api/session');
    if (session.authenticated) {
      state.authenticated = true;
      showAppScreen();
      await loadInitialData();
    } else {
      showLoginScreen();
    }
  } catch {
    showLoginScreen();
  }
});
