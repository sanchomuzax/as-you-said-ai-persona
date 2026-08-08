// Project-select synchronisation (issue #38): every place a project can be
// picked (the four tab-level dropdowns, the context sidebar's own select),
// plus the persona/questionnaire lists that follow whichever project is
// active. Extracted out of app.js, which had grown past the project's
// file-size limit (coding-style: 800 lines max) — a pure move, no behaviour
// change. The shared `state` object, apiCall and the render* functions these
// call stay in app.js/runs-list.js/interview.js; the browser gives every
// classic script the same global scope, so calling them from here is safe.

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
