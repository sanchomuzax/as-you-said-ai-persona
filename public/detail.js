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
  versions:
    'A perszónák és kérdőívek megváltoztathatatlan pillanatképek: a szerkesztés ÚJ verziót hoz létre, a régit érintetlenül hagyja. Egy lefutott kutatás mindig arra a verzióra hivatkozik, amelyik ténylegesen válaszolt — enélkül visszamenőleg megváltozna, „ki" válaszolt.',
  projectRuns:
    'A projekt SAJÁT kérdőívein indított futtatások. A globális (projekthez nem kötött) kérdőíven indított futtatások itt nem jelennek meg — azokat a Futtatások fülön találod.'
};

/** Status badge with a tooltip; the title attribute is omitted when there is nothing to say. */
function statusBadge(status) {
  const tooltip = statusTooltip(status);
  const title = tooltip ? ` title="${escapeHtml(tooltip)}"` : '';
  return `<span class="badge badge-${escapeHtml(status || 'pending')}"${title}>${escapeHtml(statusLabel(status))}</span>`;
}

/**
 * An explained label is focusable and carries the explanation as its accessible
 * name (issue #12): the explanations are the substance of this UI, and a
 * hover-only `title` reaches neither a keyboard user nor a touch screen. A label
 * with nothing to explain stays out of the tab order.
 */
function detailField(label, value, tooltip) {
  const labelAttrs = tooltip
    ? ` class="detail-label chip-explained" title="${escapeHtml(tooltip)}" tabindex="0" role="note"` +
      ` aria-label="${escapeHtml(label)} — ${escapeHtml(tooltip)}"`
    : ' class="detail-label"';
  return `
    <div class="detail-field">
      <span${labelAttrs}>${escapeHtml(label)}</span>
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

/**
 * A screen reader reads the title and the meta line and then has no idea what
 * the row does, so the action is named explicitly per entity kind.
 */
const ENTITY_OPEN_LABELS = {
  projects: 'Projekt megnyitása',
  personas: 'Perszóna megnyitása',
  questionnaires: 'Kérdőív megnyitása',
  runs: 'Futtatás megnyitása'
};

function openLabel(kind, title) {
  const action = ENTITY_OPEN_LABELS[kind] || 'Megnyitás';
  return escapeHtml(`${action}: ${title}`);
}

function entityListItem(kind, id, title, meta) {
  return `
    <div class="list-item list-item-clickable" data-entity="${escapeHtml(kind)}" data-entity-id="${escapeHtml(id)}"
         role="button" tabindex="0" aria-label="${openLabel(kind, title)}">
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
      <div class="list-item list-item-clickable" data-run="${escapeHtml(r.id)}"
           role="button" tabindex="0" aria-label="${openLabel('runs', r.name)}">
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

function renderPersonaDetail(persona, project, versions) {
  const base = `
    <div class="detail-grid">
      ${detailField('Név', persona.name)}
      ${detailField('Verzió', 'v' + (persona.version || 1), DETAIL_TOOLTIPS.versions)}
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
    detailSection('Provenance (forrás)', provenance, DETAIL_TOOLTIPS.provenance) +
    detailSection('Verziók', renderVersionHistory(versions) + personaVersionForm(persona), DETAIL_TOOLTIPS.versions)
  );
}

function renderQuestionnaireDetail(questionnaire, project, versions) {
  const questions = questionnaire.questions || [];
  const meta = `
    <div class="detail-grid">
      ${detailField('Név', questionnaire.name)}
      ${detailField('Verzió', 'v' + (questionnaire.version || 1), DETAIL_TOOLTIPS.versions)}
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

  return (
    detailSection('Kérdőív adatai', meta) +
    detailSection('Kérdések', body) +
    detailSection('Verziók', renderVersionHistory(versions) + questionnaireVersionForm(questionnaire), DETAIL_TOOLTIPS.versions)
  );
}

/** Version history with a per-version diff, so an edit is auditable, not just visible. */
function renderVersionHistory(versions) {
  if (versions === null || versions === undefined) {
    return '<p class="detail-note detail-note-warning">A verziótörténet nem tölthető be — ez nem jelenti azt, hogy nincs korábbi verzió.</p>';
  }
  const list = Array.isArray(versions) ? versions : [];
  if (list.length <= 1) return '<p class="detail-note">Egyetlen verzió — még nem szerkesztették.</p>';

  return list
    .map((version, i) => {
      const previous = i > 0 ? list[i - 1] : null;
      const diff = previous ? renderVersionDiff(diffVersions(previous, version)) : '<p class="detail-note">Ez az eredeti verzió.</p>';
      const badge = version.isLatest ? ' <span class="badge badge-kind">legfrissebb</span>' : '';
      const kind = version.questions ? 'questionnaires' : 'personas';
      return `
        <div class="version-entry list-item-clickable" data-entity="${kind}" data-entity-id="${escapeHtml(version.id)}"
             role="button" tabindex="0" aria-label="${openLabel(kind, `v${version.version}`)}">
          <div class="version-entry-title">v${escapeHtml(version.version)}${badge}
            <span class="version-entry-date">${escapeHtml(formatDateTime(version.createdAt))}</span>
          </div>
          ${diff}
        </div>
      `;
    })
    .reverse()
    .join('');
}

function personaVersionForm(persona) {
  const demographics = Object.entries(persona.demographics || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
  const provenance = Object.entries(persona.provenance || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
  return `
    <form class="detail-edit-form" id="personaVersionForm" data-persona-id="${escapeHtml(persona.id)}" style="display: none;">
      <div class="form-group">
        <label for="personaVersionName">Név *</label>
        <input type="text" id="personaVersionName" value="${escapeHtml(persona.name)}" required>
      </div>
      <div class="form-group">
        <label for="personaVersionDemographics">Demográfia (kulcs: érték, egy sorban)</label>
        <textarea id="personaVersionDemographics" rows="6">${escapeHtml(demographics)}</textarea>
      </div>
      <div class="form-group">
        <label for="personaVersionBiography">Életrajz</label>
        <textarea id="personaVersionBiography" rows="4">${escapeHtml(persona.biography || '')}</textarea>
      </div>
      <div class="form-group">
        <label for="personaVersionProvenance">Provenance / forrás (kulcs: érték, egy sorban)</label>
        <textarea id="personaVersionProvenance" rows="3">${escapeHtml(provenance)}</textarea>
        <span class="detail-note">Üresen hagyva törli a rögzített forrást.</span>
      </div>
      <div class="form-group">
        <label for="personaVersionStyle" title="${escapeHtml(DETAIL_TOOLTIPS.renderingStyle)}">Renderelési stílus</label>
        <select id="personaVersionStyle">
          <option value="bulleted_profile"${persona.renderingStyle === 'bulleted_profile' ? ' selected' : ''}>Felsorolás profil</option>
          <option value="natural_language_sentence"${persona.renderingStyle === 'natural_language_sentence' ? ' selected' : ''}>Természetes nyelv</option>
        </select>
      </div>
      <div class="detail-edit-actions">
        <button type="submit" class="btn btn-primary btn-sm">Új verzió mentése</button>
        <button type="button" class="btn btn-secondary btn-sm" data-action="cancel-version-edit">Mégse</button>
        <span class="error-message" id="personaVersionError"></span>
      </div>
    </form>
    <button type="button" class="btn btn-secondary btn-sm" data-action="edit-persona">Szerkesztés (új verzió)</button>
  `;
}

function questionnaireVersionForm(questionnaire) {
  const text = questionsToText(questionnaire.questions);
  return `
    <form class="detail-edit-form" id="questionnaireVersionForm" data-questionnaire-id="${escapeHtml(questionnaire.id)}" style="display: none;">
      <div class="form-group">
        <label for="questionnaireVersionName">Kérdőív neve *</label>
        <input type="text" id="questionnaireVersionName" value="${escapeHtml(questionnaire.name)}" required>
      </div>
      <div class="form-group">
        <label for="questionnaireVersionText" title="A kérdés végén szögletes zárójelben a kérdés típusa áll (pl. [multi_choice]). Ez dönti el, hogyan kérdezzük meg: többválaszosnál opciónkénti független valószínűséget kérünk. Ha törlöd, a mentés hibát jelez — típus nélkül nem tippelünk.">Kérdések (üres sor választ el; a típus a kérdés végén, szögletes zárójelben)</label>
        <textarea id="questionnaireVersionText" rows="12">${escapeHtml(text)}</textarea>
      </div>
      <div class="detail-edit-actions">
        <button type="submit" class="btn btn-primary btn-sm">Új verzió mentése</button>
        <button type="button" class="btn btn-secondary btn-sm" data-action="cancel-version-edit">Mégse</button>
        <span class="error-message" id="questionnaireVersionError"></span>
      </div>
    </form>
    <button type="button" class="btn btn-secondary btn-sm" data-action="edit-questionnaire">Szerkesztés (új verzió)</button>
  `;
}
