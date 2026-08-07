// Scale type and direction picker for questionnaire editor.
// Provides a UI for selecting question scale types instead of typing English tokens.

const SCALE_TYPES = [
  {
    value: 'single_choice',
    label: 'Egyválaszos',
    explanation: 'A válaszadó egy opciót választ; az opciók valószínűsége 1-re normalizálódik.'
  },
  {
    value: 'multi_choice',
    label: 'Többválaszos',
    explanation: 'A válaszadó több opciót is megjelölhet; az opciónkénti valószínűség függetlenül 0–1 között van.'
  },
  {
    value: 'frequency',
    label: 'Gyakorisági skála',
    explanation: 'Egy tevékenység gyakoriságát méri (pl. soha – ritkán – néha – gyakran – mindig).'
  },
  {
    value: 'ordinal',
    label: 'Sorrendi skála',
    explanation: 'Rendezett opciók, melyek sorrendje számít, de az intervallumok nem egyformák (pl. egyetértés).'
  },
  {
    value: 'categorical',
    label: 'Kategoriális',
    explanation: 'Önálló kategóriák, melyek között nincs természetes sorrend vagy hierarchia.'
  }
];

const SCALE_DIRECTIONS = [
  { value: 'ascending', label: 'Növekvő' },
  { value: 'descending', label: 'Csökkenő' }
];

/**
 * Creates a HTML snippet for a scale picker UI (select dropdowns).
 * Returns { html, containerId } so the caller can integrate it into the form.
 */
function createScalePickerHtml(questionIndex, currentScaleType = null, currentDirection = null) {
  const containerId = `scale-picker-${questionIndex}`;
  const typeSelectId = `scale-type-${questionIndex}`;
  const directionSelectId = `scale-direction-${questionIndex}`;
  const explanationId = `scale-explanation-${questionIndex}`;

  // If no current value, default to categorical
  const selectedType = currentScaleType || 'categorical';
  const selectedDirection = currentDirection || 'ascending';
  const selectedTypeObj = SCALE_TYPES.find(t => t.value === selectedType) || SCALE_TYPES[4];

  const typeOptions = SCALE_TYPES.map(t =>
    `<option value="${t.value}"${t.value === selectedType ? ' selected' : ''}>${t.label}</option>`
  ).join('');

  const directionOptions = SCALE_DIRECTIONS.map(d =>
    `<option value="${d.value}"${d.value === selectedDirection ? ' selected' : ''}>${d.label}</option>`
  ).join('');

  const html = `
    <div class="scale-picker" id="${containerId}">
      <div class="scale-picker-controls">
        <div class="form-group scale-picker-control">
          <label for="${typeSelectId}">Kérdés típusa</label>
          <select id="${typeSelectId}" class="scale-type-select">
            ${typeOptions}
          </select>
        </div>
        <div class="form-group scale-picker-control">
          <label for="${directionSelectId}">Skála iránya</label>
          <select id="${directionSelectId}" class="scale-direction-select">
            ${directionOptions}
          </select>
        </div>
      </div>
      <div class="scale-explanation" id="${explanationId}">
        ${selectedTypeObj.explanation}
      </div>
    </div>
  `;

  return {
    html,
    containerId,
    typeSelectId,
    directionSelectId,
    explanationId
  };
}

/**
 * Attaches event listeners to a scale picker to update explanations dynamically.
 * @param {string} typeSelectId - ID of the scale type select element
 * @param {string} explanationId - ID of the explanation div
 */
function attachScalePickerListener(typeSelectId, explanationId) {
  const typeSelect = document.getElementById(typeSelectId);
  const explanation = document.getElementById(explanationId);

  if (!typeSelect || !explanation) return;

  typeSelect.addEventListener('change', (e) => {
    const selectedValue = e.target.value;
    const selectedType = SCALE_TYPES.find(t => t.value === selectedValue);
    if (selectedType) {
      explanation.textContent = selectedType.explanation;
    }
  });
}

/**
 * Extracts scale type and direction from the question text marker.
 * @param {string} questionText - The question text, possibly ending with [type] or [type, direction]
 * @returns {object} { text, scaleType, scaleDirection }
 */
function extractScaleMarker(questionText) {
  if (!questionText) return { text: '', scaleType: null, scaleDirection: null };

  const match = questionText.match(/\[([a-z_]+)(?:\s*,\s*(ascending|descending))?\]$/i);
  if (!match) return { text: questionText, scaleType: null, scaleDirection: null };

  const scaleType = match[1].toLowerCase();
  const scaleDirection = (match[2] || 'ascending').toLowerCase();
  const text = questionText.slice(0, match.index).trim();

  return { text, scaleType, scaleDirection };
}

/**
 * Reconstructs the question text with the scale marker appended.
 * @param {string} questionText - The raw question text (without marker)
 * @param {string} scaleType - The scale type value
 * @param {string} scaleDirection - The scale direction value
 * @returns {string} The question text with marker appended
 */
function reconstructScaleMarker(questionText, scaleType, scaleDirection) {
  if (!questionText) return questionText;

  const type = scaleType || 'categorical';
  const direction = (scaleDirection && scaleDirection !== 'ascending') ? `, ${scaleDirection}` : '';

  return `${questionText} [${type}${direction}]`;
}

/**
 * Validates a scale marker extracted from a question.
 * Returns { isValid, error } where error is a user-friendly message if invalid.
 */
function validateScaleMarker(scaleType) {
  const validTypes = SCALE_TYPES.map(t => t.value);
  if (!scaleType || !validTypes.includes(scaleType)) {
    return {
      isValid: false,
      error: `Ismeretlen kérdéstípus: "${scaleType}". Érvényes értékek: ${validTypes.join(', ')}`
    };
  }
  return { isValid: true, error: null };
}
