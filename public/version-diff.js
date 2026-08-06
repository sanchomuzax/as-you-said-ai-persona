// Version comparison helper: compares two snapshots and reports what changed.
// Pure string builder (no DOM access) so it stays unit-testable; app.js does
// the data loading and click wiring. All interpolated values go through
// escapeHtml — these render user- and model-supplied text.

/**
 * Normalizes a value for comparison: treats null, undefined, and empty string
 * as equivalent (all representing absence).
 */
function normalize(val) {
  if (val === null || val === undefined || val === '') {
    return null;
  }
  return val;
}

/**
 * Compares two arrays of strings for equality.
 * Both arrays must be in the same order and have identical elements.
 */
function arraysEqual(arr1, arr2) {
  if (!Array.isArray(arr1) || !Array.isArray(arr2)) {
    return false;
  }
  if (arr1.length !== arr2.length) {
    return false;
  }
  return arr1.every((val, idx) => val === arr2[idx]);
}

/**
 * Checks if an object has at least one field that the differ inspects.
 * Comparable fields: name, biography, renderingStyle, demographics, provenance, questions.
 *
 * @param {Record<string, unknown>} obj - The object to check
 * @returns {boolean} true if the object has at least one comparable field
 */
function hasComparableFields(obj) {
  if (!obj || typeof obj !== 'object') {
    return false;
  }

  const comparableFields = ['name', 'biography', 'renderingStyle', 'demographics', 'provenance', 'questions'];
  return comparableFields.some(field => field in obj && obj[field] != null);
}

/**
 * Compares two persona (or questionnaire) snapshots and returns a list of changes.
 *
 * Fields compared (when present): name, biography, renderingStyle, demographics, provenance, questions.
 * Nested objects (demographics, provenance) are reported per key.
 * Questions are compared positionally by array index: text, options (ordered), scaleType, scaleDirection.
 *
 * @param {Record<string, unknown>} previous - The earlier version
 * @param {Record<string, unknown>} current - The newer version
 * @returns {Array<{field: string, kind: 'added' | 'removed' | 'changed', from: unknown, to: unknown}>}
 */
function diffVersions(previous, current) {
  const changes = [];
  const scalarFields = ['name', 'biography', 'renderingStyle'];
  const nestedFields = ['demographics', 'provenance'];

  // Track which nested fields we've already processed, so we don't double-report
  const processedNested = new Set();

  // Compare scalar fields in order
  for (const field of scalarFields) {
    const prevVal = previous?.[field] ?? null;
    const currVal = current?.[field] ?? null;

    const prevNorm = normalize(prevVal);
    const currNorm = normalize(currVal);

    if (prevNorm !== currNorm) {
      const kind = prevNorm === null
        ? 'added'
        : currNorm === null
        ? 'removed'
        : 'changed';

      changes.push({
        field,
        kind,
        from: prevVal,
        to: currVal
      });
    }
  }

  // Compare nested objects (demographics, provenance) per key, alphabetically
  for (const field of nestedFields) {
    const prevObj = previous?.[field];
    const currObj = current?.[field];

    const prevKeys = prevObj ? Object.keys(prevObj).sort() : [];
    const currKeys = currObj ? Object.keys(currObj).sort() : [];
    const allKeys = Array.from(new Set([...prevKeys, ...currKeys])).sort();

    for (const key of allKeys) {
      const prevVal = prevObj?.[key] ?? null;
      const currVal = currObj?.[key] ?? null;

      const prevNorm = normalize(prevVal);
      const currNorm = normalize(currVal);

      if (prevNorm !== currNorm) {
        const kind = prevNorm === null
          ? 'added'
          : currNorm === null
          ? 'removed'
          : 'changed';

        changes.push({
          field: `${field}.${key}`,
          kind,
          from: prevVal,
          to: currVal
        });
      }
    }
  }

  // Compare questions array positionally
  // Questions are compared by index (ordinal position), not by ID.
  const prevQuestions = Array.isArray(previous?.questions) ? previous.questions : [];
  const currQuestions = Array.isArray(current?.questions) ? current.questions : [];

  const maxQuestionsIdx = Math.max(prevQuestions.length, currQuestions.length);

  for (let idx = 0; idx < maxQuestionsIdx; idx++) {
    const prevQ = prevQuestions[idx];
    const currQ = currQuestions[idx];
    const qNum = idx + 1; // 1-based index for user-friendly display

    // Question added (exists in current but not in previous)
    if (!prevQ && currQ) {
      changes.push({
        field: `kérdés ${qNum}`,
        kind: 'added',
        from: null,
        to: currQ
      });
      continue;
    }

    // Question removed (exists in previous but not in current)
    if (prevQ && !currQ) {
      changes.push({
        field: `kérdés ${qNum}`,
        kind: 'removed',
        from: prevQ,
        to: null
      });
      continue;
    }

    // Both exist: check for changes within the question
    if (prevQ && currQ) {
      // Check text field
      const prevText = normalize(prevQ.text);
      const currText = normalize(currQ.text);
      if (prevText !== currText) {
        changes.push({
          field: `kérdés ${qNum} szövege`,
          kind: 'changed',
          from: prevQ.text,
          to: currQ.text
        });
      }

      // Check options (ordered array comparison)
      const prevOptions = Array.isArray(prevQ.options) ? prevQ.options : [];
      const currOptions = Array.isArray(currQ.options) ? currQ.options : [];
      if (!arraysEqual(prevOptions, currOptions)) {
        changes.push({
          field: `kérdés ${qNum} opciói`,
          kind: 'changed',
          from: prevQ.options,
          to: currQ.options
        });
      }

      // Check scaleType field
      const prevScaleType = normalize(prevQ.scaleType);
      const currScaleType = normalize(currQ.scaleType);
      if (prevScaleType !== currScaleType) {
        changes.push({
          field: `kérdés ${qNum} típusa`,
          kind: 'changed',
          from: prevQ.scaleType,
          to: currQ.scaleType
        });
      }

      // Check scaleDirection field
      const prevScaleDir = normalize(prevQ.scaleDirection);
      const currScaleDir = normalize(currQ.scaleDirection);
      if (prevScaleDir !== currScaleDir) {
        changes.push({
          field: `kérdés ${qNum} skálairánya`,
          kind: 'changed',
          from: prevQ.scaleDirection,
          to: currQ.scaleDirection
        });
      }
    }
  }

  return changes;
}

/**
 * Renders version changes as an HTML string in Hungarian.
 *
 * Empty array → a note saying nothing changed.
 * Otherwise an unordered list; each item names the field and the change.
 *
 * @param {Array<{field: string, kind: string, from: unknown, to: unknown}>} changes
 * @returns {string} HTML string
 */
function renderVersionDiff(changes) {
  if (!changes || changes.length === 0) {
    return `<p class="detail-note">Ebben a verzióban nem történt változás.</p>`;
  }

  const items = changes
    .map(({ field, kind, from, to }) => {
      const fieldLabel = escapeHtml(field);

      // Format the values: arrays (options) become comma-joined strings,
      // objects become JSON, everything else is escaped
      const formatValue = (val) => {
        if (val === null || val === undefined || val === '') {
          return '—';
        }
        if (Array.isArray(val)) {
          // Options array: join with ", " for readability
          return escapeHtml(val.join(', '));
        }
        if (typeof val === 'object') {
          return escapeHtml(JSON.stringify(val));
        }
        return escapeHtml(String(val));
      };

      const fromStr = formatValue(from);
      const toStr = formatValue(to);

      let change;
      if (kind === 'added') {
        change = `<span class="version-diff-value">${toStr}</span> (új)`;
      } else if (kind === 'removed') {
        change = `<span class="version-diff-value">${fromStr}</span> (törölve)`;
      } else {
        // 'changed'
        change = `<span class="version-diff-value">${fromStr}</span> → <span class="version-diff-value">${toStr}</span>`;
      }

      return `<li>${fieldLabel}: ${change}</li>`;
    })
    .join('');

  return `<ul class="version-diff">${items}</ul>`;
}
