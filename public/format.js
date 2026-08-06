// Pure text/number formatting helpers shared by the UI.
// No DOM access on purpose: these are unit-tested without a browser environment.

/**
 * Escapes every character that could break out of a text OR an attribute
 * context. Quotes matter: escaped values are also interpolated into title="…"
 * tooltips, where a bare quote would let model or user text inject markup.
 */
function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatNumber(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '0';
  return Number(n).toLocaleString('hu-HU');
}

function formatCost(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '0.0000';
  return Number(n).toFixed(4);
}

function formatMetric(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  return Number(n).toFixed(2);
}

/**
 * SQLite writes `datetime('now')` in UTC without a timezone marker, which V8
 * would parse as LOCAL time — showing every timestamp two hours early here.
 * Such values are explicitly marked as UTC before formatting.
 */
function formatDateTime(value) {
  if (!value) return '—';
  const text = String(value);
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(text)
    ? text.replace(' ', 'T') + 'Z'
    : text;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? text : date.toLocaleString('hu-HU');
}
