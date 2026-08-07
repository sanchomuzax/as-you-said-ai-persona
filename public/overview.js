// Overview tab (issue #20): the default landing tab. Built entirely from data
// the app already fetches — /api/runs (loadInitialData), /api/model-profiles
// (model-view.js's refreshModelList) and /api/budget (app.js's
// updateBudgetBar) — no endpoint of its own.
//
// Like the context sidebar (issue #19), this is re-rendered from `state`
// whenever one of those sources changes, not lazily on tab activation: the
// hooks live in app.js (loadInitialData, updateBudgetBar), runs-list.js
// (pollRunningProgress, which is also what fills in per-run staleVersions)
// and model-view.js (refreshModelList).

// 'failed' belongs here too (code-review defect #3): runControlButtons already
// offers Folytatás for it, and it is neither running/paused/budget_exhausted
// nor 'completed', so without this it silently vanished from the overview.
const OVERVIEW_STALLED_STATUSES = ['running', 'paused', 'budget_exhausted', 'failed'];
const OVERVIEW_RECENT_LIMIT = 5;
const OVERVIEW_BUDGET_WARNING_PCT = 80;

/** The live status if the progress poll has one cached, else the last-known row status. */
function overviewRunStatus(run) {
  return (state.runProgress[run.id] && state.runProgress[run.id].status) || run.status;
}

function overviewRunningAndStalledRuns() {
  return state.runs.filter((r) => OVERVIEW_STALLED_STATUSES.includes(overviewRunStatus(r)));
}

function overviewRecentCompletedRuns() {
  return state.runs
    .filter((r) => overviewRunStatus(r) === 'completed')
    .slice()
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, OVERVIEW_RECENT_LIMIT);
}

function overviewRunCellsAndInvalidMeta(run) {
  const progress = state.runProgress[run.id] || {};
  const totalCells = progress.totalCells ?? run.totalCells ?? 0;
  const invalid = progress.invalid ?? run.invalid_count ?? 0;
  if (!totalCells) return 'nincs cellaadat';
  return `${formatNumber(totalCells)} cella · ${Math.round(invalidPct(invalid, totalCells))}% érvénytelen`;
}

function overviewRecentRunRow(run) {
  return `
    <div class="list-item list-item-clickable" data-run="${escapeHtml(run.id)}"
         role="button" tabindex="0" aria-label="${openLabel('runs', run.name)}">
      <div>
        <div class="list-item-title">${escapeHtml(run.name)}</div>
        <div class="list-item-meta">${escapeHtml(formatDateTime(run.created_at))} · ${escapeHtml(overviewRunCellsAndInvalidMeta(run))}</div>
      </div>
      ${statusBadge(overviewRunStatus(run))}
    </div>
  `;
}

function renderOverviewRunningSection() {
  const container = document.getElementById('overviewRunningList');
  if (!container) return;
  const runs = overviewRunningAndStalledRuns();
  container.innerHTML =
    runs.length === 0
      ? '<p class="placeholder">Nincs futó vagy megszakadt mérés.</p>'
      : runs.map((r) => renderRunCard(r)).join('');
}

function renderOverviewRecentRuns() {
  const container = document.getElementById('overviewRecentRuns');
  if (!container) return;
  const runs = overviewRecentCompletedRuns();
  container.innerHTML =
    runs.length === 0
      ? '<p class="placeholder">Nincs még befejezett futtatás.</p>'
      : runs.map(overviewRecentRunRow).join('');
}

/**
 * Uncalibrated/stale models: without a valid profile there is nothing to read
 * a persona result against.
 *
 * Code-review defect #1 ("hangos hiány"): state.modelProfiles is just as empty
 * on a FAILED /api/model-profiles fetch as when every model is genuinely fine
 * — those two cases must never render the same "all clear" text. When the
 * fetch itself failed (state.modelProfilesError, set by model-view.js's
 * refreshModelList), say so instead of silently falling through to "no
 * uncalibrated models found".
 */
function overviewModelWarning() {
  if (state.modelProfilesError) {
    return '<p class="detail-note detail-note-warning">A modellek kalibrációs állapota nem ellenőrizhető: a lekérdezése sikertelen volt.</p>';
  }
  const uncalibrated = (state.modelProfiles || []).filter((m) => m.status !== 'valid');
  if (uncalibrated.length === 0) return '';
  const names = uncalibrated.map((m) => escapeHtml(m.label)).join(', ');
  // Own sentence per status, not CALIBRATION_TOOLTIPS.missing verbatim: that
  // tooltip text is single-model and describes only "missing" ("still no
  // measurement") — appended to a mixed missing+stale list it misdescribes a
  // stale profile, which DOES have a measurement, merely an outdated one.
  return `<p class="detail-note detail-note-warning">Kalibrálatlan vagy elavult profilú modell(ek): ${names}. Kalibrálatlan modellnél nincs mihez viszonyítani a perszóna hatását a modell alapértelmezett válaszához képest; elavult profilnál van mérés, de az már nem érvényes a jelenlegi összeállításra.</p>`;
}

function overviewRunHasStaleVersion(run) {
  const staleVersions = state.runProgress[run.id] && state.runProgress[run.id].staleVersions;
  if (!staleVersions) return false;
  const staleQuestionnaire =
    staleVersions.questionnaire && staleVersions.questionnaire.used !== staleVersions.questionnaire.latest;
  const stalePersonas = Array.isArray(staleVersions.personas) && staleVersions.personas.length > 0;
  return Boolean(staleQuestionnaire || stalePersonas);
}

/** A run whose /progress fetch failed (runs-list.js's pollRunningProgress) — staleness genuinely unknown, not "current". */
function overviewRunProgressUnchecked(run) {
  return Boolean(state.runProgressErrors && state.runProgressErrors[run.id]);
}

/**
 * Runs whose persona/questionnaire version has since been superseded — the
 * result no longer matches what is live — plus, separately (defect #1), runs
 * whose staleness could not even be determined because the progress fetch
 * that carries staleVersions failed.
 */
function overviewStaleVersionWarning() {
  const runs = state.runs || [];
  const staleRuns = runs.filter((r) => !overviewRunProgressUnchecked(r) && overviewRunHasStaleVersion(r));
  const uncheckedRuns = runs.filter(overviewRunProgressUnchecked);
  const parts = [];
  if (staleRuns.length > 0) {
    const names = staleRuns.map((r) => escapeHtml(r.name)).join(', ');
    parts.push(`<p class="detail-note detail-note-warning">Elavult perszóna- vagy kérdőív-verzióval készült futtatás(ok): ${names}. Az eredmény már nem a jelenleg érvényes verziót tükrözi.</p>`);
  }
  if (uncheckedRuns.length > 0) {
    // No run names here (unlike the stale-run message above): this can fire
    // for any run whose /progress request simply hasn't resolved yet, not
    // only a genuine, actionable failure, so naming them would be noise
    // rather than something to act on. The count says what it is: the
    // verdict is unknown, not clean.
    parts.push(`<p class="detail-note detail-note-warning">${uncheckedRuns.length} futtatás verzió-frissessége nem ellenőrizhető, mert a lekérdezés sikertelen volt.</p>`);
  }
  return parts.join('');
}

/**
 * limit 0 = the hard stop is off (see app.js's updateBudgetBar) — a percentage
 * would be meaningless. state.budgetError (set by app.js's updateBudgetBar on
 * a failed /api/budget fetch) is checked first: state.budgetData is just as
 * null on a failure as before the first fetch, and neither means "under
 * budget" (defect #1).
 */
function overviewBudgetWarning() {
  if (state.budgetError) {
    return '<p class="detail-note detail-note-warning">A token-keret állapota nem ellenőrizhető: a lekérdezése sikertelen volt.</p>';
  }
  const data = state.budgetData;
  const limit = data && data.limits && data.limits.globalBudget;
  if (!data || !limit) return '';
  const used = (data.global && data.global.totalTokens) || 0;
  const pct = (used / limit) * 100;
  if (pct < OVERVIEW_BUDGET_WARNING_PCT) return '';
  return `<p class="detail-note detail-note-warning">A globális token-keret ${Math.round(pct)}%-on áll — átlépte a ${OVERVIEW_BUDGET_WARNING_PCT}%-os figyelmeztetési szintet.</p>`;
}

function renderOverviewWarnings() {
  const container = document.getElementById('overviewWarnings');
  if (!container) return;
  const parts = [overviewModelWarning(), overviewStaleVersionWarning(), overviewBudgetWarning()].filter(Boolean);
  container.innerHTML = parts.length > 0 ? parts.join('') : '<p class="placeholder">Nincs figyelmeztetés.</p>';
}

/** Repaints every part of the overview tab from the current state. Safe to call before all sources have loaded. */
function renderOverviewTab() {
  renderOverviewRunningSection();
  renderOverviewRecentRuns();
  renderOverviewWarnings();
}

/** Switches tab like the nav buttons do (app.js), then opens the tab's creator form so the click is a one-step jump. */
function overviewQuickJump(tabName, formId) {
  state.activeTab = tabName;
  closeRunDetail(false);
  closeEntityDetail(false);
  closeInterviewDetail(false);
  closeModelDetail(false);
  setActiveTab(tabName);
  setHash(tabName, null);
  const form = document.getElementById(formId);
  const toggle = document.querySelector('[aria-controls="' + formId + '"]');
  if (form && toggle) expandCreatorForm(form, toggle);
}

document.getElementById('overviewQuickRun')?.addEventListener('click', () => overviewQuickJump('runs', 'runForm'));
document.getElementById('overviewQuickInterview')?.addEventListener('click', () => overviewQuickJump('interviews', 'interviewForm'));
document.getElementById('overviewQuickCalibration')?.addEventListener('click', () => overviewQuickJump('models', 'calibrationForm'));

// Running/stalled cards reuse runs-list.js's own markup and actions (pause /
// resume / stop / details) rather than duplicating them — same delegated
// click pattern as #runsList there.
document.getElementById('overviewRunningList')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (btn) {
    await handleRunAction(btn.dataset.action, btn.dataset.run);
    return;
  }
  const card = e.target.closest('.run-card[data-run-card]');
  if (card) {
    rememberDetailTrigger('data-run-card', card.dataset.runCard, e.currentTarget);
    await handleRunAction('details', card.dataset.runCard);
  }
});
