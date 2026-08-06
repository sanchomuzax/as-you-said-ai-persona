// Detail views for projects, personas and questionnaires.
// Pure string builders (no DOM access) so they stay unit-testable; app.js does
// the data loading and click wiring. All interpolated values go through
// escapeHtml — these render user- and model-supplied text.

const DETAIL_TOOLTIPS = {
  provenance:
    'A perszóna demográfiai magjának forrása. A módszertan szerint az anchor core külső statisztikai forrásból származzon (pl. KSH), nem a modell találhatja ki — ezért itt jelezzük a forrást, a lekérés dátumát és az arányokat.',
  renderingStyle:
    'Hogyan renderelődik a perszóna a promptba: felsorolás-profilként vagy természetes nyelvű mondatként. A rendering-stílus önmagában is befolyásolja a válaszokat, ezért rögzítjük.',
  demographics: 'A perszóna demográfiai mezői. Ezek kerülnek a promptba; modellnév és kísérleti metaadat soha nem.',
  options:
    'A kérdés válaszopciói eredeti sorrendben. A futtatás során az opciók sorrendjét ciklikusan rotáljuk (balanced permutation), hogy a sorrendi torzítás mérhető legyen.',
  questionCount: 'A kérdőív kérdéseinek száma. Egy futtatás cellaszáma: kérdésenkénti opciószám × perszónák × seedek.',
  projectRuns:
    'A projekt SAJÁT kérdőívein indított futtatások. A globális (projekthez nem kötött) kérdőíven indított futtatások itt nem jelennek meg — azokat a Futtatások fülön találod.'
};

/** Status badge with a tooltip; the title attribute is omitted when there is nothing to say. */
function statusBadge(status) {
  const tooltip = statusTooltip(status);
  const title = tooltip ? ` title="${escapeHtml(tooltip)}"` : '';
  return `<span class="badge badge-${escapeHtml(status || 'pending')}"${title}>${escapeHtml(statusLabel(status))}</span>`;
}

function detailField(label, value, tooltip) {
  const title = tooltip ? ` title="${escapeHtml(tooltip)}"` : '';
  return `
    <div class="detail-field">
      <span class="detail-label"${title}>${escapeHtml(label)}</span>
      <span class="detail-value">${escapeHtml(value === null || value === undefined || value === '' ? '—' : value)}</span>
    </div>
  `;
}

function detailKeyValues(obj, emptyText) {
  const entries = Object.entries(obj || {});
  if (entries.length === 0) return `<p class="detail-note">${escapeHtml(emptyText)}</p>`;
  return `<div class="detail-grid">${entries
    .map(([key, value]) => detailField(key, typeof value === 'object' ? JSON.stringify(value) : value))
    .join('')}</div>`;
}

function entityListItem(kind, id, title, meta) {
  return `
    <div class="list-item list-item-clickable" data-entity="${escapeHtml(kind)}" data-entity-id="${escapeHtml(id)}" role="button" tabindex="0">
      <div>
        <div class="list-item-title">${escapeHtml(title)}</div>
        ${meta ? `<div class="list-item-meta">${escapeHtml(meta)}</div>` : ''}
      </div>
    </div>
  `;
}

function detailSection(title, body, tooltip) {
  const heading = tooltip ? `<h3 title="${escapeHtml(tooltip)}">${escapeHtml(title)}</h3>` : `<h3>${escapeHtml(title)}</h3>`;
  return `<div class="detail-section">${heading}${body}</div>`;
}

function renderProjectDetail(project, context) {
  const personas = context.personas || [];
  const questionnaires = context.questionnaires || [];
  const runs = context.runs || [];

  const meta = `
    <div class="detail-grid">
      ${detailField('Név', project.name)}
      ${detailField('Alkalmazási terület', project.applicationDomain)}
      ${detailField('Célpopuláció', project.targetPopulation)}
      ${detailField('Létrehozva', formatDateTime(project.createdAt))}
      ${detailField('Azonosító', project.id)}
    </div>
  `;

  const personaList = personas.length
    ? personas
        .map((p) =>
          entityListItem(
            'personas',
            p.id,
            p.name,
            Object.entries(p.demographics || {})
              .map(([k, v]) => k + ': ' + v)
              .join(', ')
          )
        )
        .join('')
    : '<p class="detail-note">Nincs perszóna ebben a projektben.</p>';

  const questionnaireList = questionnaires.length
    ? questionnaires
        .map((q) => entityListItem('questionnaires', q.id, q.name, (q.questions || []).length + ' kérdés'))
        .join('')
    : '<p class="detail-note">Nincs kérdőív ebben a projektben.</p>';

  const runList = runs.length
    ? runs
        .map(
          (r) => `
      <div class="list-item list-item-clickable" data-run="${escapeHtml(r.id)}" role="button" tabindex="0">
        <div>
          <div class="list-item-title">${escapeHtml(r.name)}</div>
          <div class="list-item-meta">${escapeHtml(formatDateTime(r.created_at))}</div>
        </div>
        ${statusBadge(r.status)}
      </div>
    `
        )
        .join('')
    : '<p class="detail-note">Nincs futtatás a projekt saját kérdőívein.</p>';

  const editForm = `
    <form class="detail-edit-form" id="projectEditForm" data-project-id="${escapeHtml(project.id)}" style="display: none;">
      <div class="form-group">
        <label for="projectEditName">Projekt neve *</label>
        <input type="text" id="projectEditName" value="${escapeHtml(project.name)}" required>
      </div>
      <div class="form-group">
        <label for="projectEditDomain">Alkalmazási terület</label>
        <input type="text" id="projectEditDomain" value="${escapeHtml(project.applicationDomain || '')}">
      </div>
      <div class="form-group">
        <label for="projectEditPopulation">Célpopuláció</label>
        <input type="text" id="projectEditPopulation" value="${escapeHtml(project.targetPopulation || '')}">
      </div>
      <div class="detail-edit-actions">
        <button type="submit" class="btn btn-primary btn-sm">Mentés</button>
        <button type="button" class="btn btn-secondary btn-sm" data-action="cancel-project-edit">Mégse</button>
        <span class="error-message" id="projectEditError"></span>
      </div>
    </form>
    <button type="button" class="btn btn-secondary btn-sm" data-action="edit-project">Adatok szerkesztése</button>
  `;

  return (
    detailSection('Projekt adatai', meta + editForm) +
    detailSection('Perszónák (' + personas.length + ')', personaList) +
    detailSection('Kérdőívek (' + questionnaires.length + ')', questionnaireList) +
    detailSection('Futtatások (' + runs.length + ')', runList, DETAIL_TOOLTIPS.projectRuns)
  );
}

const RENDERING_STYLE_LABELS = {
  bulleted_profile: 'Felsorolás profil',
  natural_language_sentence: 'Természetes nyelv'
};

function renderPersonaDetail(persona, project) {
  const base = `
    <div class="detail-grid">
      ${detailField('Név', persona.name)}
      ${detailField('Projekt', project ? project.name : '—')}
      ${detailField('Renderelési stílus', RENDERING_STYLE_LABELS[persona.renderingStyle] || persona.renderingStyle, DETAIL_TOOLTIPS.renderingStyle)}
      ${detailField('Létrehozva', formatDateTime(persona.createdAt))}
      ${detailField('Azonosító', persona.id)}
    </div>
  `;

  const biography = persona.biography
    ? `<p class="detail-text">${escapeHtml(persona.biography)}</p>`
    : '<p class="detail-note">Nincs életrajz rögzítve.</p>';

  // An empty provenance object is as undocumented as a missing one — both must
  // raise the methodology warning, never a neutral note.
  const hasProvenance = !!persona.provenance && Object.keys(persona.provenance).length > 0;
  const provenance = hasProvenance
    ? detailKeyValues(persona.provenance, 'Nincs rögzített forrás.')
    : '<p class="detail-note detail-note-warning">Nincs rögzített forrás — a demográfiai mag eredete nem dokumentált. A módszertan külső statisztikai forrást ír elő (anchor core), enélkül az eredmény provenance-a nem ellenőrizhető.</p>';

  return (
    detailSection('Alapadatok', base) +
    detailSection('Demográfia', detailKeyValues(persona.demographics, 'Nincs demográfiai adat.'), DETAIL_TOOLTIPS.demographics) +
    detailSection('Életrajz', biography) +
    detailSection('Provenance (forrás)', provenance, DETAIL_TOOLTIPS.provenance)
  );
}

function renderQuestionnaireDetail(questionnaire, project) {
  const questions = questionnaire.questions || [];
  const meta = `
    <div class="detail-grid">
      ${detailField('Név', questionnaire.name)}
      ${detailField('Projekt', project ? project.name : '(globális kérdőív)')}
      ${detailField('Kérdések száma', questions.length + ' kérdés', DETAIL_TOOLTIPS.questionCount)}
      ${detailField('Azonosító', questionnaire.id)}
    </div>
  `;

  const body = questions.length
    ? questions
        .map(
          (q, i) => `
      <div class="question-detail">
        <div class="question-detail-title">${i + 1}. ${escapeHtml(q.text)}</div>
        <ol class="option-list" type="A" title="${escapeHtml(DETAIL_TOOLTIPS.options)}">
          ${(q.options || []).map((opt) => `<li>${escapeHtml(opt)}</li>`).join('')}
        </ol>
      </div>
    `
        )
        .join('')
    : '<p class="detail-note">Nincs kérdés ebben a kérdőívben.</p>';

  return detailSection('Kérdőív adatai', meta) + detailSection('Kérdések', body);
}
