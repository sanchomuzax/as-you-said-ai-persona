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
  // Personas and questionnaires have a by-id endpoint that also serves superseded
  // versions; the list endpoint returns latest-only, so a link to an older version
  // would otherwise report that an existing row does not exist.
  if (kind === 'personas' || kind === 'questionnaires') {
    return await apiCall('GET', `/api/${kind}/${encodeURIComponent(id)}`);
  }
  const items = await apiCall('GET', '/api/projects');
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
    state.currentEntityData = entity;
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
  const [project, versions] = await Promise.all([
    entity.projectId ? loadProject(entity.projectId) : Promise.resolve(null),
    loadVersions(kind, entity.id)
  ]);
  return kind === 'personas'
    ? renderPersonaDetail(entity, project, versions)
    : renderQuestionnaireDetail(entity, project, versions);
}

/** Version history is informative, not essential: a failure must not blank the page. */
async function loadVersions(kind, id) {
  try {
    return await apiCall('GET', `/api/${kind}/${encodeURIComponent(id)}/versions`);
  } catch {
    // null, not []: an empty list would read as "never edited", which is a claim
    // we cannot make when the request failed.
    return null;
  }
}

/**
 * The form renders values as text, so an untouched number would come back as a
 * string and quietly change the stored record. Where the text still matches the
 * original, the original (typed) value is kept.
 */
function keepTypedValues(parsed, original) {
  const source = original || {};
  return Object.fromEntries(
    Object.entries(parsed).map(([key, value]) =>
      key in source && String(source[key]) === value ? [key, source[key]] : [key, value]
    )
  );
}

async function saveNewVersion(kind, form) {
  const errorEl = document.getElementById(kind === 'personas' ? 'personaVersionError' : 'questionnaireVersionError');
  errorEl.textContent = '';
  const source = state.currentEntityData || {};
  try {
    const body =
      kind === 'personas'
        ? {
            name: document.getElementById('personaVersionName').value,
            demographics: keepTypedValues(
              parseDemographics(document.getElementById('personaVersionDemographics').value),
              source.demographics
            ),
            biography: document.getElementById('personaVersionBiography').value || undefined,
            renderingStyle: document.getElementById('personaVersionStyle').value,
            provenance: nonEmptyRecord(
              keepTypedValues(
                parseDemographics(document.getElementById('personaVersionProvenance').value),
                source.provenance
              )
            )
          }
        : {
            name: document.getElementById('questionnaireVersionName').value,
            questions: parseQuestions(document.getElementById('questionnaireVersionText').value)
          };
    const sourceId = kind === 'personas' ? form.dataset.personaId : form.dataset.questionnaireId;
    const created = await apiCall('POST', `/api/${kind}/${encodeURIComponent(sourceId)}/versions`, body);
    // The new version is a different row, so the detail view moves with it.
    await openEntityDetail(kind, created.id, true);
    await refreshListsFor(kind);
  } catch (err) {
    errorEl.textContent = 'Mentés sikertelen: ' + err.message;
  }
}

function nonEmptyRecord(record) {
  return Object.keys(record).length > 0 ? record : undefined;
}

async function refreshListsFor(kind) {
  if (kind === 'personas') await reloadPersonasList();
  else await reloadQuestionnairesList(state.selectedProjectId);
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
  restoreDetailFocus();
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
    const action = actionBtn.dataset.action;
    if (action === 'edit-project') toggleProjectEditForm(true);
    if (action === 'cancel-project-edit') toggleProjectEditForm(false);
    if (action === 'edit-persona') toggleVersionForm('personaVersionForm', 'edit-persona', true);
    if (action === 'edit-questionnaire') toggleVersionForm('questionnaireVersionForm', 'edit-questionnaire', true);
    if (action === 'cancel-version-edit') {
      toggleVersionForm('personaVersionForm', 'edit-persona', false);
      toggleVersionForm('questionnaireVersionForm', 'edit-questionnaire', false);
    }
    return;
  }
  const runRow = target.closest('[data-run]:not(button)');
  if (runRow) {
    rememberDetailTrigger('data-run', runRow.dataset.run);
    setHash('runs', runRow.dataset.run);
    state.activeTab = 'runs';
    setActiveTab('runs');
    await openRunDetail(runRow.dataset.run, true);
    return;
  }
  const row = target.closest('[data-entity][data-entity-id]');
  if (!row) return;
  rememberDetailTrigger('data-entity-id', row.dataset.entityId);
  await openEntityDetail(row.dataset.entity, row.dataset.entityId, true);
}

function toggleVersionForm(formId, buttonAction, show) {
  const form = document.getElementById(formId);
  const button = document.querySelector(`#entityDetailBody [data-action="${buttonAction}"]`);
  if (!form || !button) return;
  form.style.display = show ? 'block' : 'none';
  button.style.display = show ? 'none' : 'inline-block';
}

document.getElementById('entityDetailBody')?.addEventListener('submit', (e) => {
  e.preventDefault();
  if (e.target.id === 'projectEditForm') void saveProjectEdit(e.target);
  if (e.target.id === 'personaVersionForm') void saveNewVersion('personas', e.target);
  if (e.target.id === 'questionnaireVersionForm') void saveNewVersion('questionnaires', e.target);
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
