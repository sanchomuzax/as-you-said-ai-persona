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
 * timer). Recognized by the config marker the calibrate endpoint writes —
 * ONLY that (issue #29 review round 2, MED): a name-matching fallback used
 * to also count a run merely titled "Kalibráció — X" as active, which the
 * server's own guard (src/model-profiles.ts) never does, so a flagless
 * legacy run made the browser block a launch the server would actually
 * allow. Identity is the flag; a run without it is not this model's
 * calibration run as far as either side is concerned.
 */
function calibrationRunsFor(modelId) {
  return (state.runs || [])
    .filter((run) => {
      const config = parsedRunConfig(run);
      return config.model === modelId && config.calibration === true;
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

/**
 * Everything the on-card workflow needs, computed from already-fetched
 * state. `checkedRunIds` (Set|null) carries the step-4 checkbox selection a
 * forced repaint must not silently reset — see rerenderModelDetailBody.
 */
function modelCardContext(modelId, checkedRunIds) {
  return {
    probes: state.probeQuestionnaires || [],
    calibrationRuns: calibrationRunsFor(modelId),
    checkedRunIds: checkedRunIds || null
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
 * and when nothing changed (same diff-guard as the sidebar's running section) —
 * UNLESS `force` is set (issue #29 review HIGH #3). The guard exists to
 * protect typing in a text field during a background tick (the periodic 5s
 * poll, or an unrelated SSE 'status' event); it was never meant to survive an
 * explicit action taken ON this card, like clicking its own Stop button.
 *
 * The reasoning for why `force` is safe here is NOT "a click moves focus onto
 * a button, not a text field, so there is nothing left to protect" — a
 * repaint replaces `body.innerHTML` outright, which destroys a half-typed
 * text field's VALUE regardless of where focus is; that would be real data
 * loss if it could happen. It cannot: the probe select and the provider
 * input are both rendered `disabled` for the whole time a calibration is
 * active (renderCalibrationWorkflow), which is the only time this module
 * calls with `force: true`. Skipping the repaint here would just freeze the
 * card on "Fut" forever instead — the poll only retries while something is
 * still 'running', which is no longer true right after Stop. runs-list.js
 * passes `force: true` only from the explicit-action path (handleRunAction).
 *
 * A forced repaint still replaces the whole card, which would otherwise drop
 * both the step-4 checkbox selection and keyboard focus (to <body>, with no
 * way back in) even though nothing needed protecting from it. Both are
 * restored explicitly below instead.
 */
function rerenderModelDetailBody(force = false) {
  const view = document.getElementById('modelDetailView');
  const body = document.getElementById('modelDetailBody');
  if (!view || !body || view.style.display === 'none' || !state.currentModelId) return;
  if (!force && body.contains(document.activeElement) && document.activeElement !== body) return;
  const entry =
    (state.modelProfiles || []).find((m) => m.model === state.currentModelId) ||
    { model: state.currentModelId, label: state.currentModelId };
  const checkedRunIds = force
    ? new Set(Array.from(body.querySelectorAll('.model-card-runpick:checked')).map((cb) => cb.value))
    : null;
  const html = renderModelCard(entry, state.currentModelProfile, modelCardContext(state.currentModelId, checkedRunIds));
  if (body.innerHTML === html) return;
  body.innerHTML = html;
  // restoreDetailFocus is a one-shot meant for CLOSING the view (it consumes
  // its remembered trigger); staying inside the still-open card after an
  // in-place repaint is a different situation, so focus goes to the card's
  // own heading instead — the same element openModelDetail focuses on first
  // paint — rather than being left on <body>.
  if (force) document.getElementById('modelDetailTitle')?.focus();
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

/**
 * Issue #29 review round 2, HIGH 3: a failed launch used to just alert() —
 * for a 409 (the server's concurrency guard, src/model-profiles.ts) that
 * left the SECOND tab, the exact scenario the guard exists for, stale: an
 * enabled form with no sign that another run is already blocking it.
 * `apiCall` (app.js) already attaches `error.status`, so this refreshes the
 * runs list — and, if a model card happens to be open, repaints it — BEFORE
 * alerting, so the blocking run is visible the moment the dialog closes.
 * A non-409 failure (validation, network) has nothing new to show and just
 * alerts, unchanged from before.
 */
async function handleCalibrationLaunchError(err) {
  if (err.status === 409) {
    await refreshRunsList();
    if (state.currentModelId) await openModelDetail(state.currentModelId, false);
  }
  alert('A kalibráció indítása nem sikerült: ' + err.message);
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

  // In-flight guards (issue #29 review CRITICAL #2): the server-side 409 guard
  // (src/model-profiles.ts) is the correctness boundary, but two rapid submits
  // still fire two POSTs before either resolves — a double-click, or a
  // resubmit, sends the second request while the first is still in the air,
  // client-side "disabled" from a stale render notwithstanding. Set
  // SYNCHRONOUSLY, before any `await`, so the second submit (dispatched back
  // to back with the first, no tick in between) always sees it already true.
  let calibrationLaunchInFlight = false;
  let cardCalibrationLaunchInFlight = false;

  document.getElementById('calibrationForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (calibrationLaunchInFlight) return;
    const questionnaireId = document.getElementById('calibrationQuestionnaire').value;
    if (!questionnaireId) {
      alert('Válassz próba-kérdőívet a kalibrációhoz.');
      return;
    }
    const model = document.getElementById('calibrationModel').value;
    calibrationLaunchInFlight = true;
    const submitBtn = document.querySelector('#calibrationForm button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    try {
      // Lands on the model card, whose workflow shows the new run's live status
      // — the old alert() named a run id and left the researcher to go find it.
      await launchCalibration(model, questionnaireId, document.getElementById('calibrationProvider').value.trim());
    } catch (err) {
      await handleCalibrationLaunchError(err);
    } finally {
      calibrationLaunchInFlight = false;
      if (submitBtn) submitBtn.disabled = false;
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
    if (cardCalibrationLaunchInFlight) return;
    const questionnaireId = form.querySelector('.model-card-probe-select')?.value || '';
    if (!questionnaireId) {
      alert('Válassz próba-kérdőívet a kalibrációhoz.');
      return;
    }
    cardCalibrationLaunchInFlight = true;
    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    try {
      await launchCalibration(form.dataset.model, questionnaireId, form.querySelector('.model-card-provider-input')?.value.trim());
    } catch (err) {
      await handleCalibrationLaunchError(err);
    } finally {
      cardCalibrationLaunchInFlight = false;
      if (submitBtn) submitBtn.disabled = false;
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
