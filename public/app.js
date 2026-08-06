// State
let state = {
  authenticated: false,
  models: [],
  projects: [],
  selectedProjectId: null,
  personas: [],
  questionnaires: [],
  runs: [],
  currentRunDetail: null,
  eventSource: null
};

// API wrapper
async function apiCall(method, path, body = null) {
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' }
  };
  if (body) options.body = JSON.stringify(body);

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

// DOM Functions
function showLoginScreen() {
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('appContainer').style.display = 'none';
  if (state.eventSource) state.eventSource.close();
}

function showAppScreen() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('appContainer').style.display = 'flex';
}

function setActiveTab(tabName) {
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
    document.getElementById('runProjectSelect')
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
    return `
      <div class="list-item">
        <div>
          <div class="list-item-title">${escapeHtml(q.name)}</div>
          <div class="list-item-meta">${qCount} kérdés</div>
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

function renderRunsList() {
  const container = document.getElementById('runsList');
  if (state.runs.length === 0) {
    container.innerHTML = '<p class="placeholder">Nincs futtatás.</p>';
    return;
  }

  container.innerHTML = state.runs.map(r => {
    const badgeClass = 'badge badge-' + (r.status || 'pending');
    const statusLabel = {
      pending: 'Függőben',
      running: 'Futó',
      completed: 'Kész',
      budget_exhausted: 'Költségvetés elfogyott',
      failed: 'Hiba'
    }[r.status] || r.status;

    return `
      <div class="list-item" onclick="showRunDetail('${r.id}')">
        <div>
          <div class="list-item-title">${escapeHtml(r.name)}</div>
          <div class="list-item-meta">
            ${r.response_count || 0} válasz | ${r.invalid_count || 0} érvénytelen
          </div>
        </div>
        <span class="${badgeClass}">${escapeHtml(statusLabel)}</span>
      </div>
    `;
  }).join('');
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

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Detail View
async function showRunDetail(runId) {
  try {
    const runData = await apiCall('GET', '/api/runs/' + runId);
    const run = runData.run;
    const responses = runData.responses || [];
    const usage = runData.usage || {};

    state.currentRunDetail = runId;

    document.getElementById('runDetailTitle').textContent = escapeHtml(run.name);
    document.getElementById('runDetailStatus').textContent = {
      pending: 'Függőben',
      running: 'Futó',
      completed: 'Kész',
      budget_exhausted: 'Költségvetés elfogyott',
      failed: 'Hiba'
    }[run.status] || run.status;
    document.getElementById('runDetailStatus').className = 'badge badge-' + run.status;
    document.getElementById('runDetailTokens').textContent = usage.totalTokens || 0;
    document.getElementById('runDetailCost').textContent = (usage.costUsd || 0).toFixed(4);
    document.getElementById('runExportLink').href = '/api/runs/' + runId + '/export.csv';

    const tbody = document.getElementById('responsesTableBody');
    tbody.innerHTML = responses.map(r => {
      const validClass = r.is_valid ? 'valid-flag' : (r.abstained ? 'abstained-flag' : 'invalid-flag');
      const validText = r.is_valid ? '✓' : (r.abstained ? '—' : '✗');

      return `
        <tr>
          <td>${escapeHtml(r.persona_name)}</td>
          <td>${escapeHtml(r.question_text)}</td>
          <td>${escapeHtml(r.parsed_answer || '—')}</td>
          <td>${renderDistribution(r.parsed_distribution_json).outerHTML || '—'}</td>
          <td><span class="${validClass}">${validText}</span></td>
          <td>${r.seed || '—'}</td>
          <td>${escapeHtml(r.model_version || '—')}</td>
        </tr>
      `;
    }).join('');

    document.getElementById('runDetailModal').style.display = 'flex';
  } catch (err) {
    alert('Futtatás betöltése sikertelen: ' + err.message);
  }
}

// Event Subscription
function subscribeToEvents() {
  if (state.eventSource) state.eventSource.close();

  state.eventSource = new EventSource('/api/events');

  state.eventSource.addEventListener('response', (e) => {
    const evt = JSON.parse(e.data);
    if (state.currentRunDetail === evt.runId) {
      showRunDetail(evt.runId);
    }
  });

  state.eventSource.addEventListener('status', (e) => {
    const evt = JSON.parse(e.data);
    apiCall('GET', '/api/runs')
      .then(runs => {
        state.runs = runs;
        renderRunsList();
        if (state.currentRunDetail === evt.runId) {
          showRunDetail(evt.runId);
        }
      })
      .catch(() => {});
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
    state.selectedProjectId = newProject.id;
    document.getElementById('personaProjectSelect').value = newProject.id;
    await reloadPersonasList();
  } catch (err) {
    alert('Projekt létrehozása sikertelen: ' + err.message);
  }
});

document.getElementById('personaProjectSelect')?.addEventListener('change', async (e) => {
  const projectId = e.target.value;
  state.selectedProjectId = projectId;
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
  state.selectedProjectId = projectId;
  if (projectId) {
    await reloadPersonasList();
  } else {
    state.personas = [];
    renderPersonasCheckboxes();
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
    const body = {
      name: document.getElementById('questionnaireName').value,
      questions
    };
    await apiCall('POST', '/api/questionnaires', body);
    document.getElementById('questionnaireForm').reset();
    const questionnaires = await apiCall('GET', '/api/questionnaires');
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
      projectId: state.selectedProjectId
    };

    await apiCall('POST', '/api/runs', body);
    document.getElementById('runForm').reset();
    const runs = await apiCall('GET', '/api/runs');
    state.runs = runs;
    renderRunsList();
    updateBudgetBar();
  } catch (err) {
    alert('Futtatás indítása sikertelen: ' + err.message);
  }
});

// Tab Navigation
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tabName = btn.dataset.tab;
    setActiveTab(tabName);
  });
});

// Modal
document.getElementById('closeDetailBtn')?.addEventListener('click', () => {
  document.getElementById('runDetailModal').style.display = 'none';
  state.currentRunDetail = null;
});

document.getElementById('runDetailModal')?.addEventListener('click', (e) => {
  if (e.target.id === 'runDetailModal') {
    document.getElementById('runDetailModal').style.display = 'none';
    state.currentRunDetail = null;
  }
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
    renderPersonasList();
    renderQuestionnairesList();
    renderRunsList();
    renderPersonasCheckboxes();
    updateBudgetBar();

    const personaSubmitBtn = document.getElementById('personaSubmitBtn');
    if (personaSubmitBtn) personaSubmitBtn.disabled = true;

    const modelSelect = document.getElementById('runModel');
    modelSelect.innerHTML = state.models.map(m =>
      `<option value="${m.id}" ${m.id === models.default ? 'selected' : ''}>${escapeHtml(m.label)}</option>`
    ).join('');

    subscribeToEvents();
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
