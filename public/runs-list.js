// Run list: cards, their controls and the progress polling that keeps them
// current. Extracted from app.js, which had grown past the project's file-size
// limit; the shared `state` object and apiCall stay in app.js, as the browser
// gives every classic script the same global scope.

function badgeClassForStatus(status) {
  return 'badge badge-' + (status || 'pending');
}

function runControlButtons(run, context, liveStatus) {
  // Code-review defect #4: the badge already prefers the live progress-poll
  // status over the stale row status; the controls must agree with it, or the
  // badge and buttons can tell two different stories for the same card.
  const status = liveStatus || run.status;
  const buttons = [];
  if (status === 'running') {
    buttons.push(`<button class="btn btn-secondary btn-sm" data-action="pause" data-run="${escapeHtml(run.id)}">Szünet</button>`);
  }
  if (status === 'paused' || status === 'budget_exhausted' || status === 'failed') {
    buttons.push(`<button class="btn btn-secondary btn-sm" data-action="resume" data-run="${escapeHtml(run.id)}">Folytatás</button>`);
  }
  if (status === 'running' || status === 'paused') {
    buttons.push(`<button class="btn btn-danger btn-sm" data-action="stop" data-run="${escapeHtml(run.id)}">Leállítás</button>`);
  }
  if (context === 'card') {
    buttons.push(`<button class="btn btn-primary btn-sm" data-action="details" data-run="${escapeHtml(run.id)}">Részletek</button>`);
  }
  return buttons.join('');
}

function invalidPct(invalid, total) {
  if (!total) return 0;
  return (invalid / total) * 100;
}

/**
 * Builds a progress-shaped object straight from a GET /api/runs row's own
 * fields (total_cells/done_cells/abstained_count/invalid_count/usage —
 * issue #22 and its follow-up, src/server.ts, one SQL statement). Used
 * wherever a live GET /api/runs/:id/progress fetch is unavailable (a
 * non-running run is never polled for it — see pollRunningProgress below) or
 * failed, so the real, already-known spend/cell-count is shown instead of a
 * fabricated 0 (code-review blocker #1: run-view.js's refreshRunDetailHeader
 * used to fall back to `state.runProgress[runId] || {}`, which is empty for
 * every run this applies to, and render "0 / 0 cella · 0 token · 0.0000 USD"
 * for a run that may have spent real tokens).
 */
function runProgressFromRow(run) {
  return {
    totalCells: run.total_cells ?? 0,
    done: run.done_cells ?? run.response_count ?? 0,
    invalid: run.invalid_count ?? 0,
    abstained: run.abstained_count ?? 0,
    usage: {
      totalTokens: run.total_tokens ?? 0,
      cachedTokens: run.cached_tokens ?? 0,
      promptTokens: run.prompt_tokens ?? 0,
      costUsd: run.cost_usd ?? 0
    }
  };
}

function renderRunCard(run) {
  // The live progress poll (state.runProgress), when present for this run,
  // still wins over the row's own fields, since it is fresher for a run
  // actually executing right now.
  const fallback = runProgressFromRow(run);
  const progress = state.runProgress[run.id] || {};
  const totalCells = progress.totalCells ?? fallback.totalCells;
  const done = progress.done ?? fallback.done;
  const invalid = progress.invalid ?? fallback.invalid;
  const abstained = progress.abstained ?? fallback.abstained;
  const usage = progress.usage || fallback.usage;
  const totalTokens = usage.totalTokens ?? 0;
  const cachedTokens = usage.cachedTokens ?? 0;
  const promptTokens = usage.promptTokens ?? 0;
  const costUsd = usage.costUsd ?? 0;
  const pct = totalCells > 0 ? Math.min((done / totalCells) * 100, 100) : 0;
  const invPct = invalidPct(invalid, totalCells);
  const status = progress.status || run.status;

  return `
    <div class="run-card" data-run-card="${escapeHtml(run.id)}">
      <div class="run-card-header">
        <div class="run-card-title">${escapeHtml(run.name)}</div>
        <span class="${badgeClassForStatus(status)}" title="${escapeHtml(statusTooltip(status))}">
          ${status === 'running' ? '<span class="pulse-dot"></span>' : ''}${escapeHtml(statusLabel(status))}
        </span>
      </div>
      <div class="progress-bar" title="${escapeHtml(TOOLTIPS.cells)}">
        <div class="progress-fill" style="width: ${pct}%"></div>
      </div>
      <div class="run-card-stats">
        ${runStatChips({ done, totalCells, invalid, abstained, totalTokens, cachedTokens, promptTokens, costUsd, invPct })}
      </div>
      <div class="run-card-controls">
        ${runControlButtons(run, 'card', status)}
      </div>
    </div>
  `;
}

function renderRunsList() {
  const container = document.getElementById('runsList');
  if (state.runs.length === 0) {
    container.innerHTML = '<p class="placeholder">Nincs futtatás.</p>';
    return;
  }

  container.innerHTML = state.runs.map(r => renderRunCard(r)).join('');
}

document.getElementById('runsList')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (btn) {
    await handleRunAction(btn.dataset.action, btn.dataset.run);
    return;
  }
  // Clicking anywhere on the card opens it, like every other list in the app.
  const card = e.target.closest('.run-card[data-run-card]');
  if (card) {
    rememberDetailTrigger('data-run-card', card.dataset.runCard, e.currentTarget);
    await handleRunAction('details', card.dataset.runCard);
  }
});

document.getElementById('runDetailControls')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const runId = btn.dataset.run;
  await handleRunAction(action, runId);
});

async function handleRunAction(action, runId) {
  try {
    if (action === 'details') {
      setHash('runs', runId);
      await openRunDetail(runId, true);
      return;
    }
    if (action === 'pause') {
      await apiCall('POST', `/api/runs/${runId}/pause`);
    } else if (action === 'resume') {
      await apiCall('POST', `/api/runs/${runId}/resume`);
    } else if (action === 'stop') {
      if (!confirm('Biztosan leállítod a futtatást? Ez a művelet nem visszavonható.')) return;
      await apiCall('POST', `/api/runs/${runId}/stop`);
    }
    await refreshRunsList();
    if (state.currentRunId === runId) {
      await refreshRunDetailHeader(runId);
    }
  } catch (err) {
    alert('Művelet sikertelen: ' + err.message);
  }
}

async function refreshRunsList() {
  try {
    const runs = await apiCall('GET', '/api/runs');
    state.runs = runs;
    renderRunsList();
    // This used to always follow up with pollRunningProgress(true) — a live
    // /progress fetch for EVERY run, not just running ones. GET /api/runs was
    // just re-fetched on the line above and already carries every field that
    // call was fetching (total_cells/done_cells/abstained_count/usage,
    // src/server.ts) — re-polling it here was pure waste. Worse: this
    // function runs on every SSE 'status' event (app.js), which fires on
    // every response, every pause/resume/stop and every evaluation — on a
    // 200-run database, one run finishing used to fire 200 /progress requests
    // (~1200 SQL statements) while a run was executing. The periodic 5s timer
    // (startProgressPolling) still keeps a genuinely running run's live
    // figures (avg latency, providers) current; nothing here needs to
    // duplicate that.
    window.renderContextSidebarRunning?.();
    window.renderOverviewTab?.();
  } catch (err) {
    // silent - keep last known state
  }
}

/**
 * Fetches live progress for running runs (tokens/cost/live status/staleness
 * detail are only available here — cell totals/done/abstained/stale_versions
 * themselves now come with GET /api/runs, see runs-list.js's renderRunCard
 * and issue #22). `includeAll` is for the aftermath of an explicit run
 * action (pause/resume/stop, runs-list.js's refreshRunsList), where any run's
 * status may just have changed; the periodic 5s timer (startProgressPolling)
 * always calls this with no argument, i.e. running runs only — it must never
 * fan out to the whole run list on its own.
 */
async function pollRunningProgress(includeAll = false) {
  const targets = includeAll
    ? state.runs
    : state.runs.filter(r => r.status === 'running');
  if (targets.length === 0) return;
  await Promise.all(targets.map(async r => {
    try {
      const progress = await apiCall('GET', `/api/runs/${r.id}/progress`);
      state.runProgress[r.id] = progress;
      state.runProgressErrors[r.id] = false;
    } catch {
      // Recorded (code-review defect #1) so the overview's stale-version
      // warning can tell "this run's staleness is genuinely unknown" apart
      // from "checked, and it is current" — both leave runProgress[r.id]
      // untouched/absent otherwise.
      state.runProgressErrors[r.id] = true;
    }
  }));
  renderRunsList();
  // The context sidebar's running-measurement section (issue #19) and the
  // overview tab (issue #20, incl. its stale-version warning, which reads
  // staleVersions off this same progress payload) both ride on this same
  // poll — neither starts a second timer of its own.
  //
  // Only the running-measurement section, not the whole sidebar (code-review
  // defect #8/H4): renderContextSidebar() also repaints the persona list,
  // which has nothing to do with run progress — repainting it here just to
  // pick up a progress tick destroys focus on a persona row for no reason.
  // window.-prefixed `?.` guards (code-review M8): these are cross-script
  // calls into context-sidebar.js/overview.js, and a bare-identifier call
  // still throws ReferenceError if that script failed to load — property
  // access on `window` does not have that gap, so a load failure surfaces as
  // itself instead of masquerading as a progress-poll error.
  window.renderContextSidebarRunning?.();
  window.renderOverviewTab?.();
  if (state.currentRunId && targets.some(r => r.id === state.currentRunId)) {
    renderRunDetailHeaderFromCache(state.currentRunId);
  }
}

function startProgressPolling() {
  if (state.progressPollTimer) clearInterval(state.progressPollTimer);
  state.progressPollTimer = setInterval(pollRunningProgress, 5000);
}
