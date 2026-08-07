// Text-format parsers for the persona and questionnaire forms.
// Pure functions (no DOM access) so the round-trip they guard — read, render,
// parse, write — is unit-testable; the version editor depends on it exactly
// reproducing what it read.

/**
 * "kulcs: érték" lines. The split is on the FIRST colon only: demographic values
 * routinely contain colons ("széleskörű: külföldi hírek (91%)…"), and splitting
 * on every colon silently truncated the anchor data on a version round-trip.
 */
function parseDemographics(text) {
  const demographics = {};
  String(text || '').split('\n').forEach(line => {
    const trimmed = line.trim();
    const separator = trimmed.indexOf(':');
    if (separator > 0) {
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim();
      if (key && value) demographics[key] = value;
    }
  });
  return demographics;
}

/**
 * Question blocks: a question line, then "- option" lines. The question line may
 * end with a marker like `[multi_choice]` or `[multi_choice, descending]`, which
 * is how the edit form round-trips the scale settings — without it a version edit
 * would silently re-ask a multi-select question as a sum-to-1 distribution.
 */
function parseQuestions(text) {
  const questions = [];
  const blocks = String(text || '').split(/\n\s*\n/).filter(b => b.trim());

  blocks.forEach(block => {
    const lines = block.trim().split('\n');
    if (lines.length === 0) return;
    const raw = lines[0].trim();
    const marker = raw.match(/\[([a-z_]+)(?:\s*,\s*(ascending|descending))?\]$/i);
    const questionText = marker ? raw.slice(0, marker.index).trim() : raw;
    const options = lines.slice(1)
      .filter(l => l.trim().startsWith('- '))
      .map(l => l.trim().substring(2));

    if (questionText && options.length > 0) {
      const question = { text: questionText, options };
      if (marker) {
        question.scaleType = marker[1].toLowerCase();
        question.scaleDirection = (marker[2] || 'ascending').toLowerCase();
      }
      questions.push(question);
    }
  });
  return questions;
}
