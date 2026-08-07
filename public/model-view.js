// "Modellek" tab controller: calibration status per configured model, the model
// card, and launching a calibration run. Pure rendering lives in model-card.js.

async function refreshModelList() {
  const container = document.getElementById('modelsList');
  if (!container) return;
  try {
    state.modelProfiles = await apiCall('GET', '/api/model-profiles');
  } catch (err) {
    container.innerHTML = `<p class="placeholder">A kalibrációs állapot betöltése nem sikerült: ${escapeHtml(err.message)}</p>`;
    return;
  }
  try {
    state.probeQuestionnaires = await apiCall('GET', '/api/questionnaires');
  } catch {
    state.probeQuestionnaires = state.probeQuestionnaires || [];
  }
  container.innerHTML = renderModelList(state.modelProfiles);
  renderCalibrationForm();
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
}

async function openModelDetail(modelId, updateHash = true) {
  const view = document.getElementById('modelDetailView');
  if (!view) return;
  document.querySelector('.tab-content').style.display = 'none';
  document.getElementById('runDetailView').style.display = 'none';
  document.getElementById('entityDetailView').style.display = 'none';
  const interviewView = document.getElementById('interviewDetailView');
  if (interviewView) interviewView.style.display = 'none';
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
    body.innerHTML = renderModelCard(entry, null);
    return;
  }
  try {
    const profile = await apiCall('GET', `/api/model-profiles/${encodeURIComponent(entry.profile.id)}`);
    // Two quick clicks must not paint one model's card under another's title.
    if (state.currentModelId !== modelId) return;
    body.innerHTML = renderModelCard(entry, profile);
  } catch (err) {
    if (state.currentModelId !== modelId) return;
    body.innerHTML = `<p class="placeholder">A modell-profil betöltése nem sikerült: ${escapeHtml(err.message)}</p>`;
  }
}

function closeModelDetail(updateHash = true) {
  const view = document.getElementById('modelDetailView');
  if (!view) return;
  view.style.display = 'none';
  document.querySelector('.tab-content').style.display = 'block';
  state.currentModelId = null;
  if (updateHash) setHash('models', null);
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('modelsList')?.addEventListener('click', (e) => {
    const row = e.target.closest('[data-model]');
    if (row) {
      rememberDetailTrigger('data-model', row.dataset.model);
      void openModelDetail(row.dataset.model);
    }
  });

  document.getElementById('modelsList')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('[data-model]');
    if (!row) return;
    e.preventDefault();
    rememberDetailTrigger('data-model', row.dataset.model);
    void openModelDetail(row.dataset.model);
  });

  document.getElementById('modelDetailBackBtn')?.addEventListener('click', () => {
    closeModelDetail();
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
      const created = await apiCall('POST', `/api/models/${encodeURIComponent(model)}/calibrate`, {
        questionnaireId,
        provider: document.getElementById('calibrationProvider').value.trim() || undefined
      });
      // The calibration is an ordinary run: it shows up in Futtatások, where its
      // progress, cost and control can be followed like any other.
      await refreshRunsList();
      alert('A kalibrációs futtatás elindult. A haladása a Futtatások fülön követhető.\nFuttatás azonosítója: ' + created.runId);
    } catch (err) {
      alert('A kalibráció indítása nem sikerült: ' + err.message);
    }
  });

  document.getElementById('profileFromRunsForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const runIds = document.getElementById('profileRunIds').value
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (runIds.length === 0) {
      alert('Adj meg legalább egy befejezett kalibrációs futtatás azonosítóját.');
      return;
    }
    try {
      await apiCall('POST', '/api/model-profiles', {
        model: document.getElementById('profileModel').value,
        runIds
      });
      document.getElementById('profileFromRunsForm').reset();
      await refreshModelList();
    } catch (err) {
      alert('A profil rögzítése nem sikerült: ' + err.message);
    }
  });
});
