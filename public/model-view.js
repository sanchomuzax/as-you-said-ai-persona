// "Modellek" tab controller: calibration status per configured model, the model
// card, and launching a calibration run. Pure rendering lives in model-card.js.

async function refreshModelList() {
  const container = document.getElementById('modelsList');
  if (!container) return;
  try {
    state.modelProfiles = await apiCall('GET', '/api/model-profiles');
    state.modelProfilesError = false;
  } catch (err) {
    // Recorded separately from modelProfiles being empty (code-review defect
    // #1): the overview's warning must say "not checked", not silently read
    // this the same as "no uncalibrated models found".
    state.modelProfilesError = true;
    container.innerHTML = `<p class="placeholder">A kalibrációs állapot betöltése nem sikerült: ${escapeHtml(err.message)}</p>`;
    // window.-prefixed (code-review M8): a plain bare-identifier call still
    // throws ReferenceError when the other script failed to load — `?.` only
    // guards a declared-but-undefined value, not an undeclared one. Property
    // access on `window` does not have that gap.
    window.renderOverviewTab?.();
    // The sidebar's calibration section must also say "not checked", never
    // keep showing the last known statuses as if they were current.
    window.renderContextSidebarCalibration?.();
    return;
  }
  try {
    state.probeQuestionnaires = await apiCall('GET', '/api/questionnaires');
  } catch {
    state.probeQuestionnaires = state.probeQuestionnaires || [];
  }
  container.innerHTML = renderModelList(state.modelProfiles);
  renderCalibrationForm();
  // The overview tab's uncalibrated/stale-model warning (issue #20) and the
  // context sidebar's calibration section both ride on this same
  // state.modelProfiles fetch.
  window.renderOverviewTab?.();
  window.renderContextSidebarCalibration?.();
}

/** The run's config, or {} — a malformed row must not take the whole list down. */
function parsedRunConfig(run) {
  try {
    return JSON.parse(run.config_json || '{}') || {};
  } catch {
    return {};
  }
}

/**
 * This model's calibration runs, newest first, with the live-polled progress
 * winning over the row's own fields (same precedence as runs-list.js's
 * renderRunCard) — a running calibration gets fresher numbers from the 5s
 * poll (runs-list.js's pollRunningProgress), everything else uses the
 * already-fetched GET /api/runs row (issue #22's enriched fields), so this
 * never fetches anything of its own (issue #29: no new endpoint, no second
 * timer). Recognized by the config marker the calibrate endpoint writes; runs
 * launched before the marker existed are caught by the launcher's own naming
 * as a fallback.
 */
function calibrationRunsFor(modelId) {
  return (state.runs || [])
    .filter((run) => {
      const config = parsedRunConfig(run);
      if (config.model !== modelId) return false;
      return config.calibration === true || run.name === `Kalibráció — ${modelId}`;
    })
    .map((run) => {
      const fallback = runProgressFromRow(run);
      const live = state.runProgress[run.id] || {};
      return {
        id: run.id,
        name: run.name,
        status: live.status || run.status,
        created_at: run.created_at,
        totalCells: live.totalCells ?? fallback.totalCells,
        done: live.done ?? fallback.done,
        usage: live.usage || fallback.usage
      };
    })
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

/** Everything the on-card workflow needs, computed from already-fetched state. */
function modelCardContext(modelId) {
  return {
    probes: state.probeQuestionnaires || [],
    calibrationRuns: calibrationRunsFor(modelId)
  };
}

/** The probe is DATA, not code: the researcher picks which questionnaire it is. */
function renderCalibrationForm() {
  const modelSelect = document.getElementById('calibrationModel');
  const questionnaireSelect = document.getElementById('calibrationQuestionnaire');
  if (!modelSelect || !questionnaireSelect) return;
  const options = (state.modelProfiles || [])
    .map((m) => `<option value="${escapeHtml(m.model)}">${escapeHtml(m.label)}</option>`)
    .join('');
  modelSelect.innerHTML = options;
  const profileModelSelect = document.getElementById('profileModel');
  if (profileModelSelect) profileModelSelect.innerHTML = options;
  // Every questionnaire, not the project-filtered list: the probe usually lives
  // in a dedicated calibration project, so filtering by the currently selected
  // project would hide exactly the one the researcher wants.
  const probes = state.probeQuestionnaires || [];
  questionnaireSelect.innerHTML =
    '<option value="">-- Válassz próba-kérdőívet --</option>' +
    probes.map((q) => `<option value="${escapeHtml(q.id)}">${escapeHtml(q.name)}</option>`).join('');
  renderProfileRunPicker();
}

/**
 * Completed calibration runs of the model picked in the tab-level "Profil
 * rögzítése" form, as checkboxes. Replaces a free-text field that expected the
 * researcher to copy-paste run ids by hand — the system already knows which
 * runs qualify, so it lists them.
 */
function renderProfileRunPicker() {
  const container = document.getElementById('profileRunPicker');
  const modelSelect = document.getElementById('profileModel');
  if (!container || !modelSelect) return;
  const model = modelSelect.value;
  if (!model) {
    container.innerHTML = '<p class="placeholder">Válassz modellt.</p>';
    return;
  }
  const completed = calibrationRunsFor(model).filter((r) => r.status === 'completed');
  if (completed.length === 0) {
    container.innerHTML =
      '<p class="detail-note">Ehhez a modellhez még nincs befejezett kalibrációs futtatás. Indíts kalibrációt (fent), és várd meg, míg befejeződik — utána itt jelenik meg.</p>';
    return;
  }
  // Re-rendered on every runs refresh (a run finishing must appear here), so
  // an in-progress selection has to survive the repaint; only a first paint
  // defaults to the newest run.
  const previouslyChecked = Array.from(container.querySelectorAll('input[name="profileRuns"]')).length
    ? new Set(
        Array.from(container.querySelectorAll('input[name="profileRuns"]:checked')).map((cb) => cb.value)
      )
    : null;
  container.innerHTML = completed
    .map(
      (r, i) => `
    <div class="checkbox-item">
      <input type="checkbox" id="profileRunPick_${i}" name="profileRuns" value="${escapeHtml(r.id)}"
        ${previouslyChecked ? (previouslyChecked.has(r.id) ? 'checked' : '') : i === 0 ? 'checked' : ''}>
      <label for="profileRunPick_${i}">${escapeHtml(r.name)} — ${escapeHtml(formatDateTime(r.created_at))}</label>
    </div>`
    )
    .join('');
}

async function openModelDetail(modelId, updateHash = true) {
  const view = document.getElementById('modelDetailView');
  if (!view) return;
  closeAllDetailViews('modelDetailView');
  document.querySelector('.tab-content').style.display = 'none';
  view.style.display = 'block';
  state.currentModelId = modelId;
  if (updateHash) setHash('models', modelId);

  const entry = (state.modelProfiles || []).find((m) => m.model === modelId) || { model: modelId, label: modelId };
  document.getElementById('modelDetailTitle').textContent = entry.label || modelId;
  document.getElementById('modelDetailStatus').outerHTML =
    `<span id="modelDetailStatus">${calibrationStatusChip(entry.status || 'missing')}</span>`;
  const body = document.getElementById('modelDetailBody');
  body.innerHTML = '<p class="placeholder">Betöltés...</p>';
  document.getElementById('modelDetailTitle').focus();

  if (!entry.profile) {
    state.currentModelProfile = null;
    body.innerHTML = renderModelCard(entry, null, modelCardContext(modelId));
    return;
  }
  try {
    const profile = await apiCall('GET', `/api/model-profiles/${encodeURIComponent(entry.profile.id)}`);
    // Two quick clicks must not paint one model's card under another's title.
    if (state.currentModelId !== modelId) return;
    state.currentModelProfile = profile;
    body.innerHTML = renderModelCard(entry, profile, modelCardContext(modelId));
  } catch (err) {
    if (state.currentModelId !== modelId) return;
    body.innerHTML = `<p class="placeholder">A modell-profil betöltése nem sikerült: ${escapeHtml(err.message)}</p>`;
  }
}

/**
 * Repaints the open model card from state — runs-list.js calls this after every
 * runs refresh so the workflow's run statuses (step 3/4) stay live while a
 * calibration executes. Skipped while focus is inside the card (a repaint would
 * pull the keyboard out of the probe select or the provider field mid-typing)
 * and when nothing changed (same diff-guard as the sidebar's running section).
 */
function rerenderModelDetailBody() {
  const view = document.getElementById('modelDetailView');
  const body = document.getElementById('modelDetailBody');
  if (!view || !body || view.style.display === 'none' || !state.currentModelId) return;
  if (body.contains(document.activeElement) && document.activeElement !== body) return;
  const entry =
    (state.modelProfiles || []).find((m) => m.model === state.currentModelId) ||
    { model: state.currentModelId, label: state.currentModelId };
  const html = renderModelCard(entry, state.currentModelProfile, modelCardContext(state.currentModelId));
  if (body.innerHTML === html) return;
  body.innerHTML = html;
}

function closeModelDetail(updateHash = true) {
  const view = document.getElementById('modelDetailView');
  if (!view) return;
  view.style.display = 'none';
  document.querySelector('.tab-content').style.display = 'block';
  state.currentModelId = null;
  state.currentModelProfile = null;
  if (updateHash) setHash(state.activeTab || 'models', null);
}

/**
 * Launches a calibration for one model and lands the researcher where the
 * result is: the model card, whose workflow now lists the new run with its
 * live status. Used by both the on-card form and the tab-level one — the old
 * flow ended in an alert() naming a run id, leaving the researcher to find
 * the Futtatások tab on their own.
 */
async function launchCalibration(model, questionnaireId, provider) {
  const created = await apiCall('POST', `/api/models/${encodeURIComponent(model)}/calibrate`, {
    questionnaireId,
    provider: provider || undefined
  });
  await refreshRunsList();
  await openModelDetail(model);
  return created;
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('modelsList')?.addEventListener('click', (e) => {
    const row = e.target.closest('[data-model]');
    if (row) {
      rememberDetailTrigger('data-model', row.dataset.model, e.currentTarget);
      void openModelDetail(row.dataset.model);
    }
  });

  document.getElementById('modelsList')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('[data-model]');
    if (!row) return;
    e.preventDefault();
    rememberDetailTrigger('data-model', row.dataset.model, e.currentTarget);
    void openModelDetail(row.dataset.model);
  });

  document.getElementById('modelDetailBackBtn')?.addEventListener('click', () => {
    closeModelDetail();
    // Same expression closeModelDetail() just used to pick the hash (issue #24,
    // following #23's fix for the run detail): Vissza returns to whichever tab
    // the researcher actually opened this model card from, not always Modellek.
    // A future cross-tab entry point would open the detail directly, bypassing
    // applyRoute, so it never touches state.activeTab — hard-coding 'models'
    // here would leave the address bar and the visible pane disagreeing after
    // Back.
    setActiveTab(state.activeTab || 'models');
    restoreDetailFocus();
  });

  document.getElementById('calibrationForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const questionnaireId = document.getElementById('calibrationQuestionnaire').value;
    if (!questionnaireId) {
      alert('Válassz próba-kérdőívet a kalibrációhoz.');
      return;
    }
    const model = document.getElementById('calibrationModel').value;
    try {
      // Lands on the model card, whose workflow shows the new run's live status
      // — the old alert() named a run id and left the researcher to go find it.
      await launchCalibration(model, questionnaireId, document.getElementById('calibrationProvider').value.trim());
    } catch (err) {
      alert('A kalibráció indítása nem sikerült: ' + err.message);
    }
  });

  document.getElementById('profileModel')?.addEventListener('change', () => renderProfileRunPicker());

  document.getElementById('profileFromRunsForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const runIds = Array.from(
      document.querySelectorAll('#profileRunPicker input[name="profileRuns"]:checked')
    ).map((cb) => cb.value);
    if (runIds.length === 0) {
      alert('Jelöld ki, melyik befejezett kalibrációs futtatás(ok)ból készüljön a profil.');
      return;
    }
    try {
      await apiCall('POST', '/api/model-profiles', {
        model: document.getElementById('profileModel').value,
        runIds
      });
      await refreshModelList();
    } catch (err) {
      alert('A profil rögzítése nem sikerült: ' + err.message);
    }
  });

  // The on-card workflow's controls. Delegated: the card re-renders on every
  // runs refresh, so direct listeners would be lost with the nodes.
  const detailBody = document.getElementById('modelDetailBody');

  detailBody?.addEventListener('submit', async (e) => {
    const form = e.target.closest('.model-card-calibrate-form');
    if (!form) return;
    e.preventDefault();
    const questionnaireId = form.querySelector('.model-card-probe-select')?.value || '';
    if (!questionnaireId) {
      alert('Válassz próba-kérdőívet a kalibrációhoz.');
      return;
    }
    try {
      await launchCalibration(form.dataset.model, questionnaireId, form.querySelector('.model-card-provider-input')?.value.trim());
    } catch (err) {
      alert('A kalibráció indítása nem sikerült: ' + err.message);
    }
  });

  detailBody?.addEventListener('click', async (e) => {
    if (e.target.closest('[data-action="goto-questionnaires"]')) {
      window.overviewQuickJump?.('questionnaires', 'questionnaireForm');
      return;
    }
    if (e.target.closest('[data-action="record-profile"]')) {
      const runIds = Array.from(detailBody.querySelectorAll('.model-card-runpick:checked')).map((cb) => cb.value);
      if (runIds.length === 0) {
        alert('Jelöld ki, melyik befejezett kalibrációs futtatás(ok)ból készüljön a profil.');
        return;
      }
      try {
        await apiCall('POST', '/api/model-profiles', { model: state.currentModelId, runIds });
        // The list's status chip and the card itself both change: the model is
        // calibrated now, and the card should show the measured profile.
        await refreshModelList();
        await openModelDetail(state.currentModelId, false);
      } catch (err) {
        alert('A profil rögzítése nem sikerült: ' + err.message);
      }
      return;
    }
    // The calibration row's own stop control (issue #29): checked before the
    // row-click branch below, since the button sits INSIDE the row that also
    // carries data-cal-run — without this it would both stop the run and
    // navigate to its detail from the same click.
    const stopBtn = e.target.closest('[data-action="stop"]');
    if (stopBtn) {
      await handleRunAction('stop', stopBtn.dataset.run);
      return;
    }
    // Issue #29 review round 3, HIGH 4: calibrationRunRow (model-card.js) now
    // renders a Folytatás control alongside Leállítás for every resumable
    // status — same handleRunAction (runs-list.js) the Futtatások list and
    // run detail view already use, so a 409 here gets the same stale-page
    // refresh as those (its own MED fix).
    const resumeBtn = e.target.closest('[data-action="resume"]');
    if (resumeBtn) {
      await handleRunAction('resume', resumeBtn.dataset.run);
      return;
    }
    const runRow = e.target.closest('[data-cal-run]');
    if (runRow) {
      rememberDetailTrigger('data-cal-run', runRow.dataset.calRun, detailBody);
      await handleRunAction('details', runRow.dataset.calRun);
    }
  });

  detailBody?.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    // A real <button> (e.g. the stop control above) already handles its own
    // Enter/Space activation — preventDefault()ing that here to redirect it
    // into "open the run detail" would silently break stopping by keyboard.
    if (e.target.closest('button, input, select, textarea')) return;
    const runRow = e.target.closest('[data-cal-run]');
    if (!runRow) return;
    e.preventDefault();
    rememberDetailTrigger('data-cal-run', runRow.dataset.calRun, detailBody);
    await handleRunAction('details', runRow.dataset.calRun);
  });
});
