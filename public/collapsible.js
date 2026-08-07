// Collapsible create/edit forms (issue #18).
//
// Every creator form used to sit open above its list, so opening a tab meant
// staring at an empty form instead of seeing where the research stood. Each
// form now starts hidden behind a labelled toggle button; the list is what
// the researcher sees first.
//
// Closing on a successful submit piggybacks on the existing handlers' own
// `form.reset()` call instead of adding a second listener inside them: per
// issue #18 rule 5 the submit handlers themselves must not change, and
// calling .reset() from script already fires a native 'reset' event on the
// form — the same moment the handler already treats as "saved". A failed
// submit alerts instead of resetting, so the form correctly stays open for
// the researcher to fix the input.
//
// Exception: `calibrationForm` (public/model-view.js) never calls .reset()
// even on success — it alerts the run id instead. Without touching that
// handler there is no observable "it worked" signal to close on, so that one
// form only closes via the toggle or Escape, not automatically after submit.

const COLLAPSIBLE_FORM_IDS = [
  'projectForm',
  'personaForm',
  'questionnaireForm',
  'runForm',
  'interviewForm',
  'calibrationForm',
  'profileFromRunsForm'
];

function collapseCreatorForm(form, toggle) {
  form.style.display = 'none';
  toggle.setAttribute('aria-expanded', 'false');
}

function expandCreatorForm(form, toggle) {
  // Cleared, not set to a concrete value: the form's own class (.form-grid)
  // decides the visible display mode, and hard-coding it here would silently
  // fall out of sync the next time that CSS changes.
  form.style.display = '';
  toggle.setAttribute('aria-expanded', 'true');
  const firstField = form.querySelector('input, select, textarea');
  if (firstField) firstField.focus();
}

function setupCollapsibleForm(formId) {
  const form = document.getElementById(formId);
  const toggle = document.querySelector('[aria-controls="' + formId + '"]');
  if (!form || !toggle) return;

  // Rule #6: never persisted, always collapsed on a fresh load — no state to
  // read here, just the closed state applied unconditionally.
  collapseCreatorForm(form, toggle);

  toggle.addEventListener('click', () => {
    if (toggle.getAttribute('aria-expanded') === 'true') {
      collapseCreatorForm(form, toggle);
    } else {
      expandCreatorForm(form, toggle);
    }
  });

  form.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    collapseCreatorForm(form, toggle);
    toggle.focus();
  });

  // See file header: this is the .reset() call the submit handler already
  // makes on success, observed rather than duplicated.
  form.addEventListener('reset', () => {
    collapseCreatorForm(form, toggle);
    toggle.focus();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  COLLAPSIBLE_FORM_IDS.forEach(setupCollapsibleForm);
});
