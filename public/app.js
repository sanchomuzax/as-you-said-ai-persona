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
  activeTab: 'projects',
  currentEntity: null
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

/**
 * One response's values. Single choice is a distribution, so each option is shown
 * as its share; multi choice values are independent probabilities and are shown
 * as-is — dividing them by their sum would recreate exactly the bug this fixes.
 */
function renderDistribution(parsed_json, isMultiChoice) {
  if (!parsed_json) return '—';
  try {
    const data = typeof parsed_json === 'string' ? JSON.parse(parsed_json) : parsed_json;
    if (!data || typeof data !== 'object') return '—';

    const entries = Object.entries(data);
    if (entries.length === 0) return '—';
    const total = entries.reduce((sum, [, v]) => sum + v, 0);
    if (!isMultiChoice && total === 0) return '—';
    if (isMultiChoice && total === 0) return 'egyik sem';

    const div = document.createElement('div');
    div.className = 'distribution-bar';

    entries.forEach(([key, value]) => {
      const pct = Math.round((isMultiChoice ? value : value / total) * 100);
      const seg = document.createElement('div');
      seg.className = 'distribution-segment' + (isMultiChoice ? ' distribution-segment-support' : '');
      seg.textContent = pct + '%';
      seg.title = key + ': ' + value;
      seg.style.width = Math.max(pct * 2, 20) + 'px';
      div.appendChild(seg);
    });

    return div;
  } catch {
    return '—';
  }
}

// ----- Hash routing (route table lives in routing.js) -----
function currentRoute() {
  return parseHash(location.hash);
}

function setHash(tab, detailId) {
  const newHash = buildHash(tab, detailId);
  if (location.hash !== newHash) {
    history.replaceState(null, '', newHash);
  }
}

window.addEventListener('hashchange', () => {
  if (!state.authenticated) return;
  applyRoute(currentRoute());
});

async function applyRoute(route) {
  if (route.runId) {
    state.activeTab = 'runs';
    setActiveTab('runs');
    await openRunDetail(route.runId, false);
  } else if (route.entityId) {
    state.activeTab = route.tab;
    setActiveTab(route.tab);
    await openEntityDetail(route.tab, route.entityId, false);
  } else {
    closeRunDetail(false);
    closeEntityDetail(false);
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
  document.getElementById('entityDetailView').style.display = 'none';
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
    if (p.applicationDomain) metaParts.push(p.applicationDomain);
    if (p.targetPopulation) metaParts.push(p.targetPopulation);
    return entityListItem('projects', p.id, p.name, metaParts.join(' | '));
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
      `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`
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
    return entityListItem('personas', p.id, p.name, demStr);
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
      projectLabel = project ? project.name : '(ismeretlen projekt)';
    }
    return entityListItem('questionnaires', q.id, q.name, qCount + ' kérdés | ' + projectLabel);
  }).join('');

  // Update run form questionnaire select
  const select = document.getElementById('runQuestionnaire');
  const currentValue = select.value;
  select.innerHTML = '<option value="">-- Válassz kérdőívet --</option>';
  select.innerHTML += state.questionnaires.map(q =>
    `<option value="${escapeHtml(q.id)}">${escapeHtml(q.name)}</option>`
  ).join('');
  select.value = currentValue;
}


// ----- Run cards / dashboard -----
function badgeClassForStatus(status) {
  return 'badge badge-' + (status || 'pending');
}

function runControlButtons(run, context) {
  const status = run.status;
  const buttons = [];
  if (status === 'running') {
    buttons.push(`<button class="btn btn-secondary btn-sm" data-action="pause" data-run="${escapeHtml(run.id)}">Szünet</button>`);
  }
  if (status === 'paused' || status === 'budget_exhausted' || status === 'failed') {
    buttons.push(`<button class="btn btn-secondary btn-sm" data-action="resume" data-run="${escapeHtml(run.id)}">Folytatás</button>`);
  }
  if (status === 'running' || status === 'paused') {
    buttons.push(`<button class="btn btn-danger btn-sm" data-action="stop" data-run="${escapeHtml(run.id)}">Leállítás</button>`);
  }
  if (context === 'card') {
    buttons.push(`<button class="btn btn-primary btn-sm" data-action="details" data-run="${escapeHtml(run.id)}">Részletek</button>`);
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
  const cachedTokens = usage.cachedTokens ?? 0;
  const promptTokens = usage.promptTokens ?? run.prompt_tokens ?? 0;
  const costUsd = usage.costUsd ?? run.cost_usd ?? 0;
  const pct = totalCells > 0 ? Math.min((done / totalCells) * 100, 100) : 0;
  const invPct = invalidPct(invalid, totalCells);
  const status = progress.status || run.status;

  return `
    <div class="run-card" data-run-card="${escapeHtml(run.id)}">
      <div class="run-card-header">
        <div class="run-card-title">${escapeHtml(run.name)}</div>
        <span class="${badgeClassForStatus(status)}" title="${escapeHtml(statusTooltip(status))}">
          ${status === 'running' ? '<span class="pulse-dot"></span>' : ''}${escapeHtml(statusLabel(status))}
        </span>
      </div>
      <div class="progress-bar" title="${escapeHtml(TOOLTIPS.cells)}">
        <div class="progress-fill" style="width: ${pct}%"></div>
      </div>
      <div class="run-card-stats">
        ${runStatChips({ done, totalCells, invalid, abstained, totalTokens, cachedTokens, promptTokens, costUsd, invPct })}
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
  if (btn) {
    await handleRunAction(btn.dataset.action, btn.dataset.run);
    return;
  }
  // Clicking anywhere on the card opens it, like every other list in the app.
  const card = e.target.closest('.run-card[data-run-card]');
  if (card) await handleRunAction('details', card.dataset.runCard);
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
      <input type="checkbox" id="persona_${escapeHtml(p.id)}" value="${escapeHtml(p.id)}" name="personas">
      <label for="persona_${escapeHtml(p.id)}">${escapeHtml(p.name)}</label>
    </div>
  `).join('');
}

function updateBudgetBar() {
  apiCall('GET', '/api/budget')
    .then(data => {
      const used = data.global.totalTokens || 0;
      const limit = data.limits.globalBudget || 1;
      const pct = Math.min((used / limit) * 100, 100);

      document.getElementById('budgetTokens').textContent = formatNumber(used);
      document.getElementById('budgetLimit').textContent = formatNumber(limit);
      document.getElementById('budgetCost').textContent = formatCost(data.global.costUsd || 0);
      document.getElementById('budgetProgress').style.width = pct + '%';
      document.querySelector('.budget-widget').title =
        TOOLTIPS.budgetBar + ' Jelenleg: ' + formatMetric(pct) + '% (' + formatNumber(used) + ' / ' + formatNumber(limit) + ' token).';
    })
    .catch(() => {
      document.getElementById('budgetTokens').textContent = '—';
      document.getElementById('budgetLimit').textContent = '—';
      document.getElementById('budgetCost').textContent = '—';
    });
}

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
    // Same "kulcs: érték" parsing as the demographics field; an empty provenance
    // stays undefined so the detail view can flag the missing source.
    const provenance = parseDemographics(document.getElementById('personaProvenance').value);
    const body = {
      name: document.getElementById('personaName').value,
      demographics: parseDemographics(document.getElementById('personaDemographics').value),
      biography: document.getElementById('personaBiography').value || undefined,
      renderingStyle: document.getElementById('personaStyle').value,
      provenance: Object.keys(provenance).length > 0 ? provenance : undefined,
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
      provider: document.getElementById('runProvider').value.trim() || undefined,
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
    closeEntityDetail(false);
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
      `<option value="${escapeHtml(m.id)}" ${m.id === models.default ? 'selected' : ''}>${escapeHtml(m.label)}</option>`
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
    await applyRoute(currentRoute());
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
