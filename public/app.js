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
  currentEntity: null,
  interviews: [],
  currentInterviewId: null,
  modelProfiles: [],
  // True after a FAILED /api/model-profiles fetch (model-view.js's
  // refreshModelList) — distinct from modelProfiles just being genuinely
  // empty/all-valid, which is why overview.js's warnings check it first
  // (code-review defect #1: "hangos hiány", never confuse "not checked" with
  // "all clear").
  modelProfilesError: false,
  // Per-run: true when the last /api/runs/:id/progress fetch failed
  // (runs-list.js's pollRunningProgress) — that payload is also where
  // staleVersions comes from, so a failed fetch must not read as "not stale".
  runProgressErrors: {},
  probeQuestionnaires: [],
  currentModelId: null,
  // Last /api/budget response (issue #20's overview reads it for the 80%
  // warning); updateBudgetBar below is the only writer.
  budgetData: null,
  // True after a FAILED /api/budget fetch — see modelProfilesError above for why
  // this is tracked separately from budgetData being merely null/unset.
  budgetError: false
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

  if (!data.success && data.error) {
    // The status rides along on the error: a caller that needs to tell "this no
    // longer exists" from "the request failed" must not have to match on the
    // message text, which is user-facing prose and changes.
    const error = new Error(data.error);
    error.status = response.status;
    throw error;
  }
  return data.data;
}

// Utility functions
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
  const route = parseHash(location.hash);
  // A blank address bar lands on the overview (issue #20), the new default
  // landing tab. This is decided HERE, not in parseHash: that function's own
  // empty-hash default is pinned to 'projects' by tests/frontend-routing.test.ts,
  // so the app-level default is layered on top instead of changing it.
  if (!location.hash || location.hash === '#') return { ...route, tab: 'overview' };
  return route;
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
  } else if (route.interviewId) {
    state.activeTab = 'interviews';
    setActiveTab('interviews');
    await openInterviewDetail(route.interviewId, false);
  } else if (route.modelId) {
    state.activeTab = 'models';
    setActiveTab('models');
    await openModelDetail(route.modelId, false);
  } else if (route.entityId) {
    state.activeTab = route.tab;
    setActiveTab(route.tab);
    await openEntityDetail(route.tab, route.entityId, false);
  } else {
    closeRunDetail(false);
    closeEntityDetail(false);
    closeInterviewDetail(false);
    closeModelDetail(false);
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
  const interviewView = document.getElementById('interviewDetailView');
  if (interviewView) interviewView.style.display = 'none';
  const modelView = document.getElementById('modelDetailView');
  if (modelView) modelView.style.display = 'none';
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
    document.getElementById('questionnaireProjectSelect'),
    document.getElementById('interviewProjectSelect'),
    // The context sidebar's project select (issue #19) is just one more entry
    // here, so it is populated the same way and can never drift from the rest.
    document.getElementById('contextSidebarProjectSelect')
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
  ['personaProjectSelect', 'runProjectSelect', 'questionnaireProjectSelect', 'interviewProjectSelect', 'contextSidebarProjectSelect'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = projectId || '';
  });
  // Picking a project on ANY tab (not just Personák) must unlock persona
  // creation: the persona form is reachable from the Runs/Interviews tabs too
  // once its project is set here, and previously only personaProjectSelect's
  // own change handler flipped this flag, leaving it disabled everywhere else.
  const personaSubmitBtn = document.getElementById('personaSubmitBtn');
  if (personaSubmitBtn) personaSubmitBtn.disabled = !projectId;
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

/**
 * The fetch and the rendering are kept in separate try/catch scopes
 * (code-review defect #7/H3): the old single .then/.catch meant an exception
 * thrown while RENDERING (e.g. a bug in renderOverviewTab) was caught by the
 * same .catch as a failed FETCH, and misreported as "budget fetch failed"
 * instead of surfacing as the rendering bug it actually is.
 */
async function updateBudgetBar() {
  let data;
  try {
    data = await apiCall('GET', '/api/budget');
  } catch {
    state.budgetError = true;
    state.budgetData = null;
    document.getElementById('budgetTokens').textContent = '—';
    document.getElementById('budgetLimit').textContent = '—';
    document.getElementById('budgetCost').textContent = '—';
    // Code-review defect #7: previously only the header widget above degraded
    // on failure — the sidebar's budget section was left on "Betöltés..."
    // forever. renderContextSidebarBudget(null, true) already has a "failed"
    // state; use it. window.-prefixed (code-review M8): a bare-identifier
    // call still throws ReferenceError if the other script failed to load —
    // `?.` alone only guards a declared-but-undefined value, not an
    // undeclared one — so a script-load failure would otherwise be
    // misreported here as a budget-fetch failure.
    window.renderContextSidebarBudget?.(null, true);
    window.renderOverviewTab?.();
    return;
  }
  state.budgetError = false;
  state.budgetData = data;

  const used = data.global.totalTokens || 0;
  const limit = data.limits.globalBudget;
  // limit 0 = a hard stop ki van kapcsolva
  const unlimited = !limit;
  const pct = unlimited ? 0 : Math.min((used / limit) * 100, 100);

  document.getElementById('budgetTokens').textContent = formatNumber(used);
  document.getElementById('budgetLimit').textContent = unlimited ? '∞' : formatNumber(limit);
  document.getElementById('budgetCost').textContent = formatCost(data.global.costUsd || 0);
  document.getElementById('budgetProgress').style.width = pct + '%';
  document.querySelector('.budget-widget').title = unlimited
    ? TOOLTIPS.budgetBar + ' A keret-korlát jelenleg KI van kapcsolva (limit=0); a fogyás: ' + formatNumber(used) + ' token.'
    : TOOLTIPS.budgetBar + ' Jelenleg: ' + formatMetric(pct) + '% (' + formatNumber(used) + ' / ' + formatNumber(limit) + ' token).';
  // The context sidebar's budget section (issue #19) and the overview
  // tab's 80% warning (issue #20) both ride on this same /api/budget
  // response — no second fetch for the same data.
  window.renderContextSidebarBudget?.(data);
  window.renderOverviewTab?.();
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

document.getElementById('interviewProjectSelect')?.addEventListener('change', async (e) => {
  const projectId = e.target.value;
  selectProjectEverywhere(projectId);
  if (projectId) {
    await reloadPersonasList();
  } else {
    state.personas = [];
    renderInterviewPersonaOptions();
  }
  await refreshInterviewsList();
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
    renderInterviewPersonaOptions();
    // Every caller of reloadPersonasList (every project select's change
    // handler, and the initial project restore below) needs the sidebar's
    // persona list to follow along — one hook instead of one per caller.
    // window.-prefixed (code-review M8): an un-guarded bare call here throws
    // "renderContextSidebar is not defined" if context-sidebar.js failed to
    // load, and this catch block would then misreport that as a persona-load
    // failure — the personas themselves loaded fine.
    window.renderContextSidebar?.();
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
      autoEvaluate: document.getElementById('runAutoEvaluate').checked,
      baselineArm: document.getElementById('runBaselineArm').checked
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
    closeInterviewDetail(false);
    closeModelDetail(false);
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
    renderInterviewModelOptions(models.default);
    renderInterviewDisclaimers();
    renderInterviewPersonaOptions();

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
      // window.-prefixed (code-review M8): see reloadPersonasList above — an
      // un-guarded bare call would misreport a missing context-sidebar.js as
      // "Adatbetöltés sikertelen" via this function's own catch below.
      window.renderContextSidebar?.();
    }
    // After the stored project is restored, so the list is not fetched twice —
    // the first, unfiltered fetch used to paint under a "no interview in this
    // project" empty state.
    await refreshInterviewsList();
    await refreshModelList();

    // One progress fetch up front so the sidebar's running-measurement section
    // (issue #19) has real totals as soon as the app appears, instead of
    // waiting for the first 5s tick of the timer started just below.
    //
    // Code-review H5 (Pi performance) flagged this as a fan-out risk on a
    // large research database (state.runProgress starts empty, so every run
    // looks "uncached" here). Left un-narrowed on purpose: the overview's
    // stale-version warning (defect #1) needs staleVersions for COMPLETED
    // runs too, fetched exactly here — narrowing this call to only
    // running/stalled rows silently made that warning wrong instead of slow
    // (verified by tests/frontend-overview.test.ts's "flags a run made with a
    // since-superseded ... version"). A real fix needs either a batched
    // /api/runs/progress endpoint or a lower per-run cost server-side; a
    // client-side scope cut is not safe without one of those.
    await pollRunningProgress();
    // Runs, their progress (incl. staleVersions) and the model profiles are
    // all loaded by this point; renderOverviewTab's own hooks (pollRunningProgress,
    // refreshModelList, updateBudgetBar) keep it current after this.
    window.renderOverviewTab?.();
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
