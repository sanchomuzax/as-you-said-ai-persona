// Permanent context sidebar (issue #19): active project, its personas, the one
// running measurement (if any) and the token budget. Visible on every tab.
//
// Everything here is built from state/endpoints the rest of the app already
// fetches — there is no server route of its own:
//  - the project select is one more entry in app.js's updateProjectDropdowns()
//    / selectProjectEverywhere(), so it can never drift from the per-tab ones;
//  - the running-measurement section is repainted from the SAME progress poll
//    runs-list.js already runs (pollRunningProgress calls renderContextSidebar
//    at the end of its cycle) — no second timer is started here;
//  - the budget section is repainted from the SAME /api/budget call the header
//    widget already makes (app.js's updateBudgetBar stores the response and
//    calls renderContextSidebarBudget with it).
// Clickable rows reuse entityListItem/openLabel (detail.js) and the existing
// handleEntityClick delegate (entity-view.js) instead of new open logic.

const BUDGET_SCOPE_LABELS = {
  run: 'Mérés',
  measurement: 'Mérés',
  interview: 'Interjú'
};

function contextSidebarRunningRun() {
  // A run's live status (from the progress poll) is more current than the
  // stale status on the run row fetched at boot; prefer it when present.
  return state.runs.find(r => (state.runProgress[r.id]?.status || r.status) === 'running') || null;
}

function renderContextSidebarPersonas() {
  const container = document.getElementById('contextSidebarPersonas');
  if (!container) return;
  if (!state.selectedProjectId) {
    container.innerHTML = '<p class="placeholder">Válassz projektet.</p>';
    return;
  }
  if (state.personas.length === 0) {
    container.innerHTML = '<p class="placeholder">Nincs perszóna.</p>';
    return;
  }
  container.innerHTML = state.personas.map(p => entityListItem('personas', p.id, p.name)).join('');
}

/**
 * Code-review defect #8: this used to unconditionally reassign innerHTML on
 * every 5s poll tick (runs-list.js's pollRunningProgress), even when nothing
 * changed — which (a) makes the aria-live="polite" region re-announce the
 * identical line to a screen reader every tick, and (b) destroys and rebuilds
 * the row's DOM node, dropping keyboard focus off it. Comparing the freshly
 * built markup against what is already there and skipping the write when
 * they match covers both the "no run" and the "run unchanged" cases without
 * hand-rolled dirty-checking of every field.
 */
function renderContextSidebarRunning() {
  const container = document.getElementById('contextSidebarRunning');
  if (!container) return;
  const run = contextSidebarRunningRun();
  let html;
  if (!run) {
    html = '<p class="detail-note">Nincs futó mérés.</p>';
  } else {
    // Issue #22: total_cells/done_cells arrive with GET /api/runs itself now;
    // the live progress poll (state.runProgress), when it has ticked for this
    // run, still wins as the fresher number.
    const progress = state.runProgress[run.id] || {};
    const total = progress.totalCells ?? run.total_cells ?? 0;
    const done = progress.done ?? run.done_cells ?? 0;
    const pct = total > 0 ? Math.min((done / total) * 100, 100) : 0;
    // The opening tag's attributes are kept on ONE line on purpose: the
    // browser normalizes in-tag whitespace on serialization (a line break
    // between attributes here becomes a single space in container.innerHTML),
    // so a multi-line tag would make the diff-check above never match even
    // when the content is genuinely unchanged, defeating defect #8's fix.
    html = `
    <div class="list-item list-item-clickable context-sidebar-run" data-run="${escapeHtml(run.id)}" role="button" tabindex="0" aria-label="${openLabel('runs', run.name)}">
      <div class="list-item-title">${escapeHtml(run.name)}</div>
      <div class="progress-bar" title="${escapeHtml(TOOLTIPS.cells)}">
        <div class="progress-fill" style="width: ${pct}%"></div>
      </div>
      <div class="list-item-meta">${formatNumber(done)} / ${formatNumber(total)} kész</div>
    </div>
  `;
  }
  if (container.innerHTML === html) return;
  container.innerHTML = html;
}

/**
 * Called by app.js's updateBudgetBar with the same /api/budget response the
 * header widget renders. `failed` (code-review defect #7/H3) distinguishes a
 * genuine fetch failure from "not fetched yet" — both leave `data` null/
 * unset, but only the first must stop showing "Betöltés..." forever.
 */
function renderContextSidebarBudget(data, failed) {
  const container = document.getElementById('contextSidebarBudget');
  if (!container) return;
  if (failed) {
    container.innerHTML = '<p class="placeholder">A token-keret nem ellenőrizhető: a lekérdezés sikertelen volt.</p>';
    return;
  }
  if (!data) {
    container.innerHTML = '<p class="placeholder">Betöltés...</p>';
    return;
  }
  const used = (data.global && data.global.totalTokens) || 0;
  const limit = data.limits && data.limits.globalBudget;
  const unlimited = !limit;
  const scopeRows = Object.entries(data.byScope || {})
    .map(([key, v]) => `<div class="list-item-meta">${escapeHtml(BUDGET_SCOPE_LABELS[key] || key)}: ${formatNumber((v && v.totalTokens) || 0)} token (${formatCost((v && v.costUsd) || 0)} USD)</div>`)
    .join('');
  container.innerHTML = `
    <div class="list-item-title">${formatNumber(used)} / ${unlimited ? '∞' : formatNumber(limit)} token · ${formatCost((data.global && data.global.costUsd) || 0)} USD</div>
    ${scopeRows}
  `;
}

/** Repaints the parts of the sidebar driven by state (project/personas/running run). */
function renderContextSidebar() {
  renderContextSidebarPersonas();
  renderContextSidebarRunning();
}

document.getElementById('contextSidebarProjectSelect')?.addEventListener('change', async (e) => {
  const projectId = e.target.value;
  selectProjectEverywhere(projectId);
  if (projectId) {
    await reloadPersonasList();
    await reloadQuestionnairesList(projectId);
  } else {
    // Code-review defect #6: clearing the project used to only reset the
    // Futtatások persona checkboxes. #personasList (Perszónák tab) and
    // #interviewPersona (the interview form's persona picker — left
    // submittable with a stale option otherwise) kept offering the previous
    // project's personas.
    state.personas = [];
    renderPersonasList();
    renderPersonasCheckboxes();
    renderInterviewPersonaOptions();
    state.questionnaires = [];
    renderQuestionnairesList();
  }
  // Code-review defect #5: this handler was copied from runProjectSelect's,
  // which never touches the interview list — unlike interviewProjectSelect's
  // own handler, so Interjúk kept showing another project's interviews after
  // switching from the sidebar.
  await refreshInterviewsList();
  renderContextSidebar();
});

// One delegated listener for the sidebar's clickable rows (personas, running
// run), same pattern as the lists in entity-view.js — reusing its handler
// rather than duplicating the open logic.
document.getElementById('contextSidebar')?.addEventListener('click', (e) => {
  void handleEntityClick(e.target, e.currentTarget);
});
document.getElementById('contextSidebar')?.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  if (!e.target.closest('[data-entity-id], [data-run]')) return;
  e.preventDefault();
  void handleEntityClick(e.target, e.currentTarget);
});
