// Detail-view controller for projects, personas and questionnaires: loading,
// open/close state and click delegation. The HTML itself is built by detail.js.

// ----- Entity detail views (project / persona / questionnaire) -----
const ENTITY_KIND_LABELS = {
  projects: 'Projekt',
  personas: 'Perszóna',
  questionnaires: 'Kérdőív'
};

/** Loads the entity fresh from the API: a detail view may be opened straight from a URL. */
async function fetchEntity(kind, id) {
  const path = { projects: '/api/projects', personas: '/api/personas', questionnaires: '/api/questionnaires' }[kind];
  if (!path) return null;
  const items = await apiCall('GET', path);
  return (items || []).find(item => item.id === id) || null;
}

async function openEntityDetail(kind, id, updateHash) {
  if (!ENTITY_KIND_LABELS[kind]) return;
  state.currentEntity = { kind, id };
  closeRunDetail(false);
  document.querySelector('.tab-content').style.display = 'none';
  const view = document.getElementById('entityDetailView');
  view.style.display = 'block';
  if (updateHash) setHash(kind, id);

  const titleEl = document.getElementById('entityDetailTitle');
  const kindEl = document.getElementById('entityDetailKind');
  const bodyEl = document.getElementById('entityDetailBody');
  kindEl.textContent = ENTITY_KIND_LABELS[kind];
  titleEl.textContent = 'Betöltés...';
  bodyEl.innerHTML = '<p class="placeholder">Betöltés...</p>';

  // Every await is followed by a staleness check: two quick clicks must not let a
  // slower earlier request paint its body under the newer entity's title.
  const isStale = () => state.currentEntity?.id !== id || state.currentEntity?.kind !== kind;

  try {
    const entity = await fetchEntity(kind, id);
    if (isStale()) return;
    if (!entity) {
      titleEl.textContent = 'Nem található';
      bodyEl.innerHTML = '<p class="error-message">Ez az elem már nem létezik.</p>';
      return;
    }
    const body = await buildEntityDetailBody(kind, entity);
    if (isStale()) return;
    titleEl.textContent = entity.name || '';
    bodyEl.innerHTML = body;
    titleEl.focus(); // move focus out of the now-hidden list for keyboard users
  } catch (err) {
    if (isStale()) return;
    titleEl.textContent = 'Hiba';
    bodyEl.innerHTML = `<p class="error-message">Betöltés sikertelen: ${escapeHtml(err.message)}</p>`;
  }
}

async function buildEntityDetailBody(kind, entity) {
  if (kind === 'projects') {
    const [personas, questionnaires, runs] = await Promise.all([
      apiCall('GET', `/api/personas?project=${encodeURIComponent(entity.id)}`),
      apiCall('GET', `/api/questionnaires?project=${encodeURIComponent(entity.id)}`),
      apiCall('GET', '/api/runs')
    ]);
    // Runs have no project column; they belong to a project through their
    // questionnaire. `?project=` also returns global questionnaires, which belong
    // to no project — those are excluded here, and the section says so.
    const ownQuestionnaires = (questionnaires || []).filter(q => q.projectId === entity.id);
    const ownIds = new Set(ownQuestionnaires.map(q => q.id));
    return renderProjectDetail(entity, {
      personas: personas || [],
      questionnaires: ownQuestionnaires,
      runs: (runs || []).filter(r => ownIds.has(r.questionnaire_id))
    });
  }
  const project = entity.projectId ? await loadProject(entity.projectId) : null;
  return kind === 'personas'
    ? renderPersonaDetail(entity, project)
    : renderQuestionnaireDetail(entity, project);
}

/** Returns the project, refreshing the cached project list if it is not there yet. */
async function loadProject(projectId) {
  const cached = state.projects.find(p => p.id === projectId);
  if (cached) return cached;
  try {
    state.projects = await apiCall('GET', '/api/projects');
    renderProjectsList();
    updateProjectDropdowns();
    return state.projects.find(p => p.id === projectId) || null;
  } catch {
    return null;
  }
}

function closeEntityDetail(updateHash) {
  state.currentEntity = null;
  const view = document.getElementById('entityDetailView');
  if (view) view.style.display = 'none';
  document.querySelector('.tab-content').style.display = 'block';
  if (updateHash) setHash(state.activeTab || 'projects', null);
}

document.getElementById('entityDetailBackBtn')?.addEventListener('click', () => {
  closeEntityDetail(true);
  setActiveTab(state.activeTab || 'projects');
});

function toggleProjectEditForm(show) {
  const form = document.getElementById('projectEditForm');
  const button = document.querySelector('#entityDetailBody [data-action="edit-project"]');
  if (!form || !button) return;
  form.style.display = show ? 'block' : 'none';
  button.style.display = show ? 'none' : 'inline-block';
}

async function saveProjectEdit(form) {
  const errorEl = document.getElementById('projectEditError');
  errorEl.textContent = '';
  try {
    await apiCall('PUT', '/api/projects/' + form.dataset.projectId, {
      name: document.getElementById('projectEditName').value,
      applicationDomain: document.getElementById('projectEditDomain').value || undefined,
      targetPopulation: document.getElementById('projectEditPopulation').value || undefined
    });
    state.projects = await apiCall('GET', '/api/projects');
    renderProjectsList();
    updateProjectDropdowns();
    await openEntityDetail('projects', form.dataset.projectId, false);
  } catch (err) {
    errorEl.textContent = 'Mentés sikertelen: ' + err.message;
  }
}

/** One delegated handler for every clickable entity row, list or detail view alike. */
async function handleEntityClick(target) {
  const actionBtn = target.closest('button[data-action]');
  if (actionBtn) {
    if (actionBtn.dataset.action === 'edit-project') toggleProjectEditForm(true);
    if (actionBtn.dataset.action === 'cancel-project-edit') toggleProjectEditForm(false);
    return;
  }
  const runRow = target.closest('[data-run]:not(button)');
  if (runRow) {
    setHash('runs', runRow.dataset.run);
    state.activeTab = 'runs';
    setActiveTab('runs');
    await openRunDetail(runRow.dataset.run, true);
    return;
  }
  const row = target.closest('[data-entity][data-entity-id]');
  if (!row) return;
  await openEntityDetail(row.dataset.entity, row.dataset.entityId, true);
}

document.getElementById('entityDetailBody')?.addEventListener('submit', (e) => {
  if (e.target.id !== 'projectEditForm') return;
  e.preventDefault();
  void saveProjectEdit(e.target);
});

['projectsList', 'personasList', 'questionnairesList', 'entityDetailBody'].forEach(id => {
  const container = document.getElementById(id);
  if (!container) return;
  container.addEventListener('click', (e) => { void handleEntityClick(e.target); });
  container.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (!e.target.closest('[data-entity-id], [data-run]')) return;
    e.preventDefault();
    void handleEntityClick(e.target);
  });
});
