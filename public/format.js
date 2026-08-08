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
 * Such values are explicitly marked as UTC before parsing. Shared by
 * formatDateTime below and model-card.js's elapsed-time calculation, so the
 * UTC-without-marker trap is handled in exactly one place.
 */
function parseUtcTimestamp(value) {
  if (!value) return null;
  const text = String(value);
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(text)
    ? text.replace(' ', 'T') + 'Z'
    : text;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = parseUtcTimestamp(value);
  return date ? date.toLocaleString('hu-HU') : String(value);
}

/**
 * Turns a stored answer into readable option text. Answers are stored as
 * original option indexes ("2"), and for multi-select as the whole selected set
 * ("0,2"); an empty string means the respondent would select none of them.
 */
function answerLabel(parsedAnswer, options, isMultiChoice) {
  if (parsedAnswer === null || parsedAnswer === undefined) return '—';
  const text = String(parsedAnswer);
  if (text === '') return isMultiChoice ? 'egyik sem' : '—';

  const list = Array.isArray(options) ? options : [];
  const labels = text.split(',').map(part => {
    const index = Number(part);
    return Number.isInteger(index) && list[index] !== undefined ? list[index] : part;
  });
  return labels.join(' + ');
}

/**
 * The inverse of parseDemographics's "kulcs: érték" split, used to keep the
 * structured key–value editor's hidden sync textarea (public/detail.js,
 * public/structured-editors.js — issue #37) in the exact text shape
 * parseDemographics expects.
 */
function pairsToText(pairs) {
  return (pairs || []).map(([k, v]) => `${k}: ${v}`).join('\n');
}

/** The inverse of the marker parsing above, used to prefill the edit form. */
function questionsToText(questions) {
  return (questions || [])
    .map(q => {
      const type = q.scaleType || 'categorical';
      const direction = q.scaleDirection && q.scaleDirection !== 'ascending' ? ', ' + q.scaleDirection : '';
      const header = q.text + ' [' + type + direction + ']';
      return [header].concat((q.options || []).map(o => '- ' + o)).join('\n');
    })
    .join('\n\n');
}
