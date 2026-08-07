// Interview mode view controller: list, creation form and the transcript view.
// Pure rendering lives in interview.js.

/**
 * The methodological warning is written once, in interview.js, and injected in
 * both places it must appear — the list and the open conversation. A reader who
 * lands on a transcript directly must see it too.
 */
function renderInterviewDisclaimers() {
  for (const id of ['interviewDisclaimer', 'interviewDetailDisclaimer']) {
    const el = document.getElementById(id);
    if (el) el.textContent = INTERVIEW_DISCLAIMER;
  }
}

async function refreshInterviewsList() {
  const container = document.getElementById('interviewsList');
  if (!container) return;
  const query = state.selectedProjectId ? `?project=${encodeURIComponent(state.selectedProjectId)}` : '';
  try {
    state.interviews = await apiCall('GET', '/api/interviews' + query);
  } catch {
    container.innerHTML = '<p class="placeholder">Az interjúk betöltése nem sikerült.</p>';
    return;
  }
  container.innerHTML =
    state.interviews.length === 0
      ? '<p class="placeholder">Nincs interjú ebben a projektben.</p>'
      : state.interviews.map(interviewListItem).join('');
}

/** The persona picker follows the project selection, like the run form does. */
function renderInterviewPersonaOptions() {
  const select = document.getElementById('interviewPersona');
  if (!select) return;
  select.innerHTML =
    '<option value="">-- Válassz perszónát --</option>' +
    state.personas
      .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`)
      .join('');
}

function renderInterviewModelOptions(defaultModel) {
  const select = document.getElementById('interviewModel');
  if (!select) return;
  select.innerHTML = state.models
    .map(
      (m) =>
        `<option value="${escapeHtml(m.id)}" ${m.id === defaultModel ? 'selected' : ''}>${escapeHtml(m.label)}</option>`
    )
    .join('');
}

async function openInterviewDetail(interviewId, updateHash = true) {
  const view = document.getElementById('interviewDetailView');
  if (!view) return;
  // The panel is pinned to one response; leaving its context must not leave it
  // hovering over unrelated data.
  closeProvenancePanel();
  closeAllDetailViews('interviewDetailView');
  document.querySelector('.tab-content').style.display = 'none';
  view.style.display = 'block';
  state.currentInterviewId = interviewId;
  if (updateHash) setHash('interviews', interviewId);

  document.getElementById('interviewTranscript').innerHTML = '<p class="placeholder">Betöltés...</p>';
  try {
    const data = await apiCall('GET', `/api/interviews/${interviewId}`);
    // Two quick clicks must not let a slower earlier request paint ITS
    // transcript under the newer interview's header — that reads as one
    // persona having said what another one said.
    if (state.currentInterviewId !== interviewId) return;
    renderInterviewDetail(data);
    document.getElementById('interviewDetailTitle').focus();
  } catch (err) {
    if (state.currentInterviewId !== interviewId) return;
    document.getElementById('interviewTranscript').innerHTML =
      `<p class="placeholder">Az interjú betöltése nem sikerült: ${escapeHtml(err.message)}</p>`;
  }
}

function renderInterviewDetail(data) {
  const { interview, messages, usage } = data;
  document.getElementById('interviewDetailTitle').textContent = interview.title;
  document.getElementById('interviewDetailMeta').innerHTML = [
    `<span>Perszóna: <strong>${escapeHtml(interview.personaName)}</strong> (v${escapeHtml(interview.personaVersion)})</span>`,
    `<span>Modell: ${escapeHtml(interview.model)}</span>`,
    `<span>Temp.: ${escapeHtml(interview.temperature)} · Seed: ${escapeHtml(interview.seed)}</span>`,
    `<span>Token: ${formatNumber(usage.totalTokens)} · ${formatCost(usage.costUsd)} USD</span>`
  ].join('');
  document.getElementById('interviewExportLink').href = `/api/interviews/${interview.id}/export.csv`;
  document.getElementById('interviewTranscript').innerHTML = renderInterviewTranscript(messages);
  scrollTranscriptToEnd();
}

function scrollTranscriptToEnd() {
  const transcript = document.getElementById('interviewTranscript');
  if (transcript) transcript.scrollTop = transcript.scrollHeight;
}

function closeInterviewDetail(updateHash = true) {
  const view = document.getElementById('interviewDetailView');
  if (!view) return;
  const wasOpen = view.style.display === 'block';
  view.style.display = 'none';
  document.querySelector('.tab-content').style.display = 'block';
  state.currentInterviewId = null;
  if (updateHash) setHash(state.activeTab || 'interviews', null);
  // Interviews have neither SSE nor progress polling, so the row's exchange
  // count would keep showing the number it had before the conversation.
  if (wasOpen) void refreshInterviewsList();
}

function numberOr(raw, fallback) {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function openInterviewTurnProvenance(messageId) {
  const interviewId = state.currentInterviewId;
  if (!interviewId || !messageId) return;
  const panel = document.getElementById('provenancePanel');
  const body = document.getElementById('provenanceBody');
  panel.style.display = 'block';
  body.innerHTML = '<p class="placeholder">Betöltés...</p>';
  try {
    const message = await apiCall('GET', `/api/interviews/${interviewId}/messages/${messageId}`);
    if (state.currentInterviewId !== interviewId) return;
    body.innerHTML = renderInterviewTurnProvenance(message);
  } catch (err) {
    body.innerHTML = `<p class="placeholder">A proveniencia betöltése nem sikerült: ${escapeHtml(err.message)}</p>`;
  }
}

async function sendInterviewQuestion() {
  const input = document.getElementById('interviewQuestion');
  const sendBtn = document.getElementById('interviewSendBtn');
  const errorBox = document.getElementById('interviewError');
  const question = input.value.trim();
  errorBox.textContent = '';
  if (!question || !state.currentInterviewId) return;

  // The button is the lock: a second send would race the server-side turn lock
  // and cost tokens for a turn that is then rejected.
  sendBtn.disabled = true;
  input.disabled = true;
  document.getElementById('interviewSpinner').style.display = 'inline-block';
  const interviewId = state.currentInterviewId;
  try {
    const data = await apiCall('POST', `/api/interviews/${interviewId}/messages`, {
      content: question
    });
    // The composer is locked during the call, but Vissza and the list rows are
    // not: the answer must not land in a transcript the researcher has left.
    if (state.currentInterviewId !== interviewId) return;
    input.value = '';
    document.getElementById('interviewTranscript').innerHTML = renderInterviewTranscript(data.messages);
    scrollTranscriptToEnd();
    updateBudgetBar();
  } catch (err) {
    if (state.currentInterviewId === interviewId) {
      errorBox.textContent = 'A kérdés elküldése nem sikerült: ' + err.message;
    }
  } finally {
    sendBtn.disabled = false;
    input.disabled = false;
    document.getElementById('interviewSpinner').style.display = 'none';
    if (state.currentInterviewId === interviewId) input.focus();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('interviewForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const personaId = document.getElementById('interviewPersona').value;
    if (!personaId) {
      alert('Válassz perszónát az interjúhoz.');
      return;
    }
    try {
      const created = await apiCall('POST', '/api/interviews', {
        projectId: state.selectedProjectId || undefined,
        personaId,
        title: document.getElementById('interviewTitle').value,
        model: document.getElementById('interviewModel').value,
        // An emptied number field parses to NaN, which serialises to null and
        // comes back as an English zod message inside a Hungarian alert.
        temperature: numberOr(document.getElementById('interviewTemperature').value, 0.8),
        seed: numberOr(document.getElementById('interviewSeed').value, 0),
        provider: document.getElementById('interviewProvider').value.trim() || undefined
      });
      document.getElementById('interviewForm').reset();
      // reset() does not fire 'change' on interviewModel — without this the
      // provider list would keep showing the just-submitted model's options.
      // refreshInterviewProviderSelect lives in provider-field.js.
      void refreshInterviewProviderSelect();
      await refreshInterviewsList();
      await openInterviewDetail(created.id);
    } catch (err) {
      alert('Az interjú létrehozása nem sikerült: ' + err.message);
    }
  });

  document.getElementById('interviewsList')?.addEventListener('click', (e) => {
    const row = e.target.closest('[data-interview-id]');
    if (row) {
      rememberDetailTrigger('data-interview-id', row.dataset.interviewId, e.currentTarget);
      void openInterviewDetail(row.dataset.interviewId);
    }
  });

  document.getElementById('interviewsList')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('[data-interview-id]');
    if (!row) return;
    e.preventDefault();
    rememberDetailTrigger('data-interview-id', row.dataset.interviewId, e.currentTarget);
    void openInterviewDetail(row.dataset.interviewId);
  });

  // Per-turn provenance: the exact conversation sent and the untouched model
  // output are large, so they are fetched only when a turn is opened.
  document.getElementById('interviewTranscript')?.addEventListener('click', (e) => {
    const turn = e.target.closest('.interview-turn-persona[data-interview-message]');
    if (turn) void openInterviewTurnProvenance(turn.dataset.interviewMessage);
  });

  document.getElementById('interviewTranscript')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const turn = e.target.closest('.interview-turn-persona[data-interview-message]');
    if (!turn) return;
    e.preventDefault();
    void openInterviewTurnProvenance(turn.dataset.interviewMessage);
  });

  document.getElementById('interviewDetailBackBtn')?.addEventListener('click', () => {
    closeInterviewDetail();
    // Same expression closeInterviewDetail() just used to pick the hash (issue
    // #24, following #23's fix for the run detail): Vissza returns to whichever
    // tab the researcher actually opened this interview from, not always
    // Interjúk. A future cross-tab entry point (e.g. a "recent interviews" row
    // on Áttekintés) would open the detail directly, bypassing applyRoute, so
    // it never touches state.activeTab — hard-coding 'interviews' here would
    // leave the address bar and the visible pane disagreeing after Back.
    setActiveTab(state.activeTab || 'interviews');
    restoreDetailFocus();
  });

  document.getElementById('interviewSendBtn')?.addEventListener('click', () => void sendInterviewQuestion());

  // Enter sends, Shift+Enter breaks the line: a research question is usually one
  // sentence, and reaching for the mouse after every turn breaks the flow.
  document.getElementById('interviewQuestion')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendInterviewQuestion();
    }
  });
});
