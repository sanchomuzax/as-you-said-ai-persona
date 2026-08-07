// Issue #28: shared wiring for every "Szolgáltató rögzítése" dropdown (run,
// interview, calibration — tab-level and the on-card one). Extracted out of
// app.js/interview-view.js/model-view.js so none of them grows further
// (coding-style: many small files, not one that keeps absorbing features).
//
// The actual data comes from ensureProviderOptions (model-view.js, caches per
// model) and is rendered with renderProviderSelectOptions (model-card.js).
// Both are defined in scripts that load AFTER this one in index.html — safe
// to reference here because these functions only ever run from an event
// fired once every script tag has already executed (DOMContentLoaded, a
// select's 'change', a form's submit), never at parse time.

/**
 * Repopulates `providerSelectId` for whichever model `modelSelectId` currently
 * names. A previously-chosen value is kept selected if it still exists in the
 * new option list (harmless when the model did not actually change); a failed
 * fetch (see ensureProviderOptions) still leaves "Nem rögzítem" selectable —
 * the field must never block the form it lives in.
 */
async function refreshProviderSelectFor(modelSelectId, providerSelectId) {
  const modelSelect = document.getElementById(modelSelectId);
  const providerSelect = document.getElementById(providerSelectId);
  if (!modelSelect || !providerSelect) return;
  const model = modelSelect.value;
  if (!model) {
    providerSelect.innerHTML = renderProviderSelectOptions([], '');
    return;
  }
  const previousValue = providerSelect.value;
  await ensureProviderOptions(model);
  // The model select may have moved on to a different model while the fetch
  // was in flight — a stale response must not overwrite a newer choice.
  if (document.getElementById(modelSelectId)?.value !== model) return;
  providerSelect.innerHTML = renderProviderSelectOptions(
    state.providerOptionsCache[model]?.options || [],
    previousValue
  );
}

function refreshRunProviderSelect() {
  return refreshProviderSelectFor('runModel', 'runProvider');
}

function refreshInterviewProviderSelect() {
  return refreshProviderSelectFor('interviewModel', 'interviewProvider');
}

function refreshCalibrationProviderSelect() {
  return refreshProviderSelectFor('calibrationModel', 'calibrationProvider');
}

document.addEventListener('DOMContentLoaded', () => {
  // Providers are per-model: every "Szolgáltató rögzítése" select has to
  // follow whichever model its paired select currently names.
  document.getElementById('runModel')?.addEventListener('change', () => {
    void refreshRunProviderSelect();
  });
  document.getElementById('interviewModel')?.addEventListener('change', () => {
    void refreshInterviewProviderSelect();
  });
  document.getElementById('calibrationModel')?.addEventListener('change', () => {
    void refreshCalibrationProviderSelect();
  });
});
