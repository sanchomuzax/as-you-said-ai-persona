// Interactive wiring for the structured kulcs–érték and kérdés–opció editors
// (issue #37): add/remove a row or option, keep each editor's hidden sync
// textarea exactly in the "kulcs: érték" / "Kérdés? [type]\n- opt" text
// parseDemographics/parseQuestions (public/parsers.js) expect, and show
// immediate, parser-accurate feedback on what will actually be saved.
//
// The HTML these functions operate on comes from two places:
//  - the static create-forms in public/index.html, hand-authored to match the
//    data-kv-*/data-q-* attributes below exactly. They have to stay static
//    (not JS-mounted) because public/app.js captures `#questionsText` by
//    reference at its own top-level (pre-DOMContentLoaded) execution —
//    replacing that node afterwards would silently orphan that listener.
//  - the dynamic version-edit forms built by public/detail.js's
//    kvEditorHtml/questionEditorHtml (pure string builders). Safe to call
//    those from here at any point, since a user can only reach them (by
//    clicking "Szerkesztés") after every script has already loaded.
//
// Everything here is delegated on `document`, so it keeps working across the
// full-innerHTML re-renders that make up navigation between detail views.

// ----- Key–value editor (demographics, provenance) -----

function kvContainerPairs(container) {
  return [...container.querySelectorAll('[data-kv-row]')].map((row) => [
    row.querySelector('[data-kv-key]').value,
    row.querySelector('[data-kv-value]').value
  ]);
}

function syncKvHidden(container) {
  const hidden = document.getElementById(container.dataset.kvEditor);
  if (!hidden) return;
  const pairs = kvContainerPairs(container);
  hidden.value = pairs.map(([k, v]) => `${k}: ${v}`).join('\n');

  const feedback = container.querySelector('[data-kv-feedback]');
  if (feedback) {
    const entries = Object.entries(parseDemographics(hidden.value));
    feedback.textContent = entries.length
      ? 'Mentéskor rögzített mezők: ' + entries.map(([k, v]) => `${k} = ${v}`).join(', ')
      : 'Még nincs kitöltött sor.';
  }
  // Nothing currently listens for this, but a hidden textarea driven by JS
  // (rather than typed into directly) should still behave like one a user
  // typed into, in case a future field grows an input/change listener.
  hidden.dispatchEvent(new Event('input', { bubbles: true }));
}

function kvRowElementHtml() {
  return `
    <input type="text" class="kv-key" data-kv-key aria-label="Kulcs" placeholder="pl. kor">
    <input type="text" class="kv-value" data-kv-value aria-label="Érték" placeholder="pl. 25">
    <button type="button" class="btn btn-secondary btn-sm kv-remove" data-kv-remove aria-label="Sor törlése">&times;</button>
  `;
}

function addKvRow(container) {
  const rowsEl = container.querySelector('[data-kv-rows]');
  const row = document.createElement('div');
  row.className = 'kv-row';
  row.dataset.kvRow = String(rowsEl.children.length);
  row.innerHTML = kvRowElementHtml();
  rowsEl.appendChild(row);
  row.querySelector('[data-kv-key]').focus();
  syncKvHidden(container);
}

function removeKvRow(container, row) {
  row.remove();
  const rowsEl = container.querySelector('[data-kv-rows]');
  // A field must always offer at least one row to fill in — an editor with
  // zero rows would be a dead end with no visible way back to "add a value".
  if (rowsEl.children.length === 0) addKvRow(container);
  else syncKvHidden(container);
}

document.addEventListener('click', (e) => {
  const addBtn = e.target.closest('[data-kv-add]');
  if (addBtn) {
    const container = addBtn.closest('[data-kv-editor]');
    if (container) addKvRow(container);
    return;
  }
  const removeBtn = e.target.closest('[data-kv-remove]');
  if (removeBtn) {
    const container = removeBtn.closest('[data-kv-editor]');
    const row = removeBtn.closest('[data-kv-row]');
    if (container && row) removeKvRow(container, row);
  }
});

document.addEventListener('input', (e) => {
  if (!e.target.matches('[data-kv-key], [data-kv-value]')) return;
  const container = e.target.closest('[data-kv-editor]');
  if (container) syncKvHidden(container);
});

// ----- Question / option editor -----

function qContainerBlocks(container) {
  return [...container.querySelectorAll('[data-q-block]')].map((block) => ({
    text: block.querySelector('[data-q-text]').value,
    options: [...block.querySelectorAll('[data-q-option]')].map((o) => o.querySelector('[data-q-option-text]').value)
  }));
}

/**
 * Rebuilds the hidden textarea from the structured rows, keeping whatever
 * scale type/direction the existing picker panel (public/scale-picker.js +
 * app.js's renderQuestionnaireScalePickers) currently shows for each
 * question — otherwise the panel's own full re-render (triggered by the
 * 'input' event dispatched below) would silently revert an already-chosen
 * scale type back to the default the moment a question or option is
 * added/removed.
 */
function syncQuestionsHidden(container) {
  const hidden = document.getElementById(container.dataset.qEditor);
  if (!hidden) return;
  const previous = parseQuestions(hidden.value);
  const pickersPanel = container.closest('.form-group')?.querySelector('.questionnaire-editor-pickers');
  const typeSelects = pickersPanel ? pickersPanel.querySelectorAll('.scale-type-select') : [];
  const directionSelects = pickersPanel ? pickersPanel.querySelectorAll('.scale-direction-select') : [];
  const blocks = qContainerBlocks(container).map((b, idx) => {
    const typeSelect = typeSelects[idx];
    const directionSelect = directionSelects[idx];
    const prev = previous[idx];
    return {
      text: b.text,
      options: b.options,
      scaleType: typeSelect?.value || prev?.scaleType,
      scaleDirection: directionSelect?.value || prev?.scaleDirection
    };
  });
  hidden.value = questionsToText(blocks);

  const feedback = container.querySelector('[data-q-feedback]');
  if (feedback) {
    const parsed = parseQuestions(hidden.value);
    feedback.textContent = parsed.length
      ? `Mentéskor ${parsed.length} kérdés kerül a kérdőívbe.`
      : 'Még nincs menthető kérdés — adj meg egy kérdésszöveget és legalább egy választ.';
  }
  hidden.dispatchEvent(new Event('input', { bubbles: true }));
}

function questionOptionRowElementHtml() {
  return `
    <span class="q-option-marker" aria-hidden="true">–</span>
    <input type="text" class="q-option-text" data-q-option-text aria-label="Válaszopció szövege" placeholder="pl. Igen">
    <button type="button" class="btn btn-secondary btn-sm q-option-remove" data-q-option-remove aria-label="Opció törlése">&times;</button>
  `;
}

function questionBlockElementHtml() {
  return `
    <div class="q-block-header">
      <span class="q-block-number"></span>
      <input type="text" class="q-text" data-q-text aria-label="Kérdés szövege" placeholder="pl. Mennyire vagy elégedett a szolgáltatással?">
      <button type="button" class="btn btn-secondary btn-sm q-block-remove" data-q-block-remove aria-label="Kérdés törlése">Kérdés törlése</button>
    </div>
    <div class="q-options" data-q-options></div>
    <button type="button" class="btn btn-secondary btn-sm q-option-add" data-q-option-add>+ Opció hozzáadása</button>
  `;
}

function renumberQuestionBlocks(blocksEl) {
  [...blocksEl.children].forEach((block, i) => {
    block.dataset.qBlock = String(i);
    const number = block.querySelector('.q-block-number');
    if (number) number.textContent = `${i + 1}.`;
  });
}

function addQuestionOption(container, block) {
  const optionsEl = block.querySelector('[data-q-options]');
  const row = document.createElement('div');
  row.className = 'q-option-row';
  row.dataset.qOption = String(optionsEl.children.length);
  row.innerHTML = questionOptionRowElementHtml();
  optionsEl.appendChild(row);
  row.querySelector('[data-q-option-text]').focus();
  syncQuestionsHidden(container);
}

function addQuestionBlock(container) {
  const blocksEl = container.querySelector('[data-q-blocks]');
  const block = document.createElement('div');
  block.className = 'q-block';
  block.dataset.qBlock = String(blocksEl.children.length);
  block.innerHTML = questionBlockElementHtml();
  blocksEl.appendChild(block);
  renumberQuestionBlocks(blocksEl);
  // A question with no options yet cannot be saved (parseQuestions drops it),
  // so it starts with the same two blank options the create-form's first
  // question has — the user fills them in rather than adding them by hand.
  addQuestionOption(container, block);
  addQuestionOption(container, block);
  block.querySelector('[data-q-text]').focus();
  syncQuestionsHidden(container);
}

function removeQuestionOption(container, block, row) {
  row.remove();
  const optionsEl = block.querySelector('[data-q-options]');
  if (optionsEl.children.length === 0) addQuestionOption(container, block);
  else syncQuestionsHidden(container);
}

function removeQuestionBlock(container, block) {
  block.remove();
  const blocksEl = container.querySelector('[data-q-blocks]');
  if (blocksEl.children.length === 0) {
    addQuestionBlock(container);
    return;
  }
  renumberQuestionBlocks(blocksEl);
  syncQuestionsHidden(container);
}

document.addEventListener('click', (e) => {
  const blockAdd = e.target.closest('[data-q-block-add]');
  if (blockAdd) {
    const container = blockAdd.closest('[data-q-editor]');
    if (container) addQuestionBlock(container);
    return;
  }
  const blockRemove = e.target.closest('[data-q-block-remove]');
  if (blockRemove) {
    const container = blockRemove.closest('[data-q-editor]');
    const block = blockRemove.closest('[data-q-block]');
    if (container && block) removeQuestionBlock(container, block);
    return;
  }
  const optionAdd = e.target.closest('[data-q-option-add]');
  if (optionAdd) {
    const container = optionAdd.closest('[data-q-editor]');
    const block = optionAdd.closest('[data-q-block]');
    if (container && block) addQuestionOption(container, block);
    return;
  }
  const optionRemove = e.target.closest('[data-q-option-remove]');
  if (optionRemove) {
    const container = optionRemove.closest('[data-q-editor]');
    const block = optionRemove.closest('[data-q-block]');
    const row = optionRemove.closest('[data-q-option]');
    if (container && block && row) removeQuestionOption(container, block, row);
  }
});

document.addEventListener('input', (e) => {
  if (!e.target.matches('[data-q-text], [data-q-option-text]')) return;
  const container = e.target.closest('[data-q-editor]');
  if (container) syncQuestionsHidden(container);
});
