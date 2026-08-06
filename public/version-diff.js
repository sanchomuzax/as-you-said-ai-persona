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
 * Compares two persona (or questionnaire) snapshots and returns a list of changes.
 *
 * Fields compared (when present): name, biography, renderingStyle, demographics, provenance.
 * Nested objects (demographics, provenance) are reported per key.
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

      // Format the values: objects become JSON, everything else is escaped
      const formatValue = (val) => {
        if (val === null || val === undefined || val === '') {
          return '—';
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
