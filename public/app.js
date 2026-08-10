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
  // The open model card's fetched profile (null while none exists) — kept so
  // rerenderModelDetailBody (model-view.js) can repaint the card with live run
  // statuses without refetching the profile on every runs refresh.
  currentModelProfile: null,
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

// ----- Detail view teardown -----
// Every detail view's DOM id and the state field(s) it owns, in one place.
// Each open*Detail used to hand-roll its own list of "every other view to
// hide" — openEntityDetail knew about runDetailView, openInterviewDetail knew
// about runDetailView + entityDetailView, openModelDetail knew about all three
// others, but openRunDetail never learned about modelDetailView at all. That
// omission (issue #30) is exactly what four independent, hand-maintained lists
// produce: a view added later never makes it into the lists written before it
// existed. One shared list fixes the whole class, not just the one instance.
const DETAIL_VIEWS = [
  { view: 'entityDetailView', clear: () => { state.currentEntity = null; } },
  { view: 'runDetailView', clear: () => { state.currentRunId = null; } },
  { view: 'interviewDetailView', clear: () => { state.currentInterviewId = null; } },
  { view: 'modelDetailView', clear: () => { state.currentModelId = null; state.currentModelProfile = null; } }
];

/**
 * Hides every detail view except `exceptViewId` (omit/pass a falsy value to
 * hide all of them) and clears the state field(s) each hidden view owns, so a
 * closed view never leaves a stale id behind for a later poll/render to act on.
 * Deliberately does not touch `.tab-content` or the hash: an opener shows its
 * own view and sets the hash right after calling this; a full close (back to a
 * tab) is handled by the individual close*Detail functions, which know which
 * tab to reveal and run their own side effects (e.g. closeInterviewDetail's
 * list refresh).
 */
function closeAllDetailViews(exceptViewId) {
  for (const { view, clear } of DETAIL_VIEWS) {
    if (view === exceptViewId) continue;
    const el = document.getElementById(view);
    if (el) el.style.display = 'none';
    clear();
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
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.remove('active');
    b.removeAttribute('aria-current');
  });

  document.getElementById('tab-' + tabName)?.classList.add('active');
  const activeTabBtn = document.querySelector('[data-tab="' + tabName + '"]');
  activeTabBtn?.classList.add('active');
  activeTabBtn?.setAttribute('aria-current', 'page');
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
    // Blocker #3: a 'status' event now also fires when an evaluation
    // (auto or manual) books spend (src/server.ts's runEvaluation) — without
    // this, the global budget widget under-reported by that spend until an
    // unrelated action (new run, page reload) happened to refetch /api/budget.
    // Every other kind of spend (a run's own responses) already goes through
    // here too, so this also closes that same gap for the widget in general.
    updateBudgetBar();
    if (state.currentRunId === evt.runId) {
      refreshRunDetailHeader(evt.runId);
    }
  });

  state.eventSource.addEventListener('evaluation', (e) => {
    const evt = JSON.parse(e.data);
    if (state.currentRunId === evt.runId && state.currentSubtab === 'evaluation') {
      loadEvaluationTab(evt.runId);
    }
    // Blocker #3: an evaluation (auto or manual) books real spend
    // (src/server.ts's runEvaluation) that used to reach neither the run's
    // card (token/cost chips) nor the global budget widget until an
    // unrelated action happened to refetch /api/runs or /api/budget — an
    // under-reported spend is a wrong number on this platform, not a stale
    // one. Unconditional (not gated on the sub-tab check above): the card
    // and the widget are visible regardless of which sub-tab, or which run,
    // is open.
    refreshRunsList();
    updateBudgetBar();
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
  state.runProgress = {};
  state.runProgressErrors = {};
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

// Render scale pickers when questionnaire textarea changes
const questionsTextarea = document.getElementById('questionsText');
if (questionsTextarea) {
  questionsTextarea.addEventListener('input', () => {
    renderQuestionnaireScalePickers('questionnaireScalePickers', questionsTextarea.value);
  });
  questionsTextarea.addEventListener('change', () => {
    renderQuestionnaireScalePickers('questionnaireScalePickers', questionsTextarea.value);
  });
}

/**
 * Renders scale pickers for each question found in the textarea.
 */
function renderQuestionnaireScalePickers(containerId, questionText) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const parsed = parseQuestions(questionText);
  if (parsed.length === 0) {
    container.innerHTML = '';
    return;
  }

  let html = '';
  parsed.forEach((q, idx) => {
    const picker = createScalePickerHtml(idx, q.scaleType, q.scaleDirection);
    html += picker.html;
  });

  container.innerHTML = html;

  // Attach listeners to all pickers
  parsed.forEach((q, idx) => {
    const picker = createScalePickerHtml(idx, q.scaleType, q.scaleDirection);
    attachScalePickerListener(picker.typeSelectId, picker.explanationId);
  });
}

document.getElementById('questionnaireForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const textarea = document.getElementById('questionsText');
    const parsed = parseQuestions(textarea.value);

    // Reconstruct questions with scale types/directions from pickers
    const questions = parsed.map((q, idx) => {
      const typeSelect = document.getElementById(`scale-type-${idx}`);
      const directionSelect = document.getElementById(`scale-direction-${idx}`);

      const scaleType = typeSelect?.value || q.scaleType || 'categorical';
      const scaleDirection = directionSelect?.value || q.scaleDirection || 'ascending';

      // Validate the scale type
      const validation = validateScaleMarker(scaleType);
      if (!validation.isValid) {
        throw new Error(validation.error);
      }

      return {
        text: q.text,
        options: q.options,
        scaleType,
        scaleDirection
      };
    });

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
    document.getElementById('questionnaireScalePickers').innerHTML = '';
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
    // reset() fires no 'change' on runModel (provider-field.js's listener).
    void refreshRunProviderSelect();
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
    window.invalidateStaleRunProgress?.(runs);
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
    void refreshRunProviderSelect();
    renderInterviewModelOptions(models.default);
    void refreshInterviewProviderSelect();
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

    // Issue #22: no progress fetch here anymore. The sidebar's
    // running-measurement section and the overview tab used to get their
    // totals/staleness by fanning out one GET /api/runs/:id/progress per run
    // right here (Code-review H5 flagged this as a Pi-performance risk on a
    // large research database — up to 4N+1 SQL statements before the correct
    // tab even appears). GET /api/runs now carries total_cells, done_cells,
    // abstained_count and stale_versions for every row in the SAME query
    // (src/server.ts), so runs-list.js/context-sidebar.js/overview.js read
    // those fields straight off state.runs; only a genuinely running run gets
    // polled live, and only by the 5s timer started below.
    window.renderContextSidebarRunning?.();
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
