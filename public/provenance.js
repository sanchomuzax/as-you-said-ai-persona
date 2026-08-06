// Render functions for response provenance (metadata trail) and per-persona transcripts.
// Pure string builders (no DOM access) following detail.js patterns:
// all interpolated values through escapeHtml, methodological notes in Hungarian,
// comments explaining structural choices.

/**
 * Renders the full provenance (metadata trail) for a single model-generated response.
 * Input is a response row from the responses table: persona_name, question_text,
 * options_json (JSON string of option array), parsed_answer, elicitation_mode,
 * prompt_rendered, raw_response, permutation_json (JSON string of index array),
 * seed, temperature, model_requested, model_version, provider,
 * prompt_tokens, completion_tokens, cached_tokens, cost_usd, latency_ms, created_at,
 * is_valid, abstained — all fields optional, missing rendered as "—".
 */
/**
 * SQLite has no boolean type: these arrive as 1/0, so a strict === true/false
 * comparison silently reports every state as unknown. Abstention is checked
 * first because it is a VALID response (is_valid = 1).
 */
function responseState(response) {
  if (!response) return '—';
  if (response.abstained) return 'tartózkodás';
  if (response.is_valid === null || response.is_valid === undefined) return '—';
  return response.is_valid ? 'érvényes' : 'nem értelmezhető kimenet';
}

/** In an audit panel "unknown" must never be rendered as "zero". */
function orDash(value, formatter) {
  return value === null || value === undefined ? '—' : formatter(value);
}

function renderResponseProvenance(response) {
  if (!response) return '<p class="detail-note">Nincs megjeleníthető adat.</p>';

  const r = response;

  // Parse optional JSON fields safely.
  let options = [];
  try {
    if (r.options_json) options = JSON.parse(r.options_json);
  } catch (e) {
    // Fall through, options stays empty.
  }

  let permutation = [];
  try {
    if (r.permutation_json) permutation = JSON.parse(r.permutation_json);
  } catch (e) {
    // Fall through.
  }

  // Determine state line: valid / abstained / invalid.
  const stateLabel = responseState(r);

  // Summary block: persona, question, resolved answer, state.
  const answerText = answerLabel(r.parsed_answer, options, r.elicitation_mode === 'multi_choice');
  const summaryBody = `
    <div class="detail-grid">
      ${detailField('Perszóna', r.persona_name)}
      ${detailField('Kérdés', r.question_text)}
      ${detailField('Válasz', answerText)}
      ${detailField('Állapot', stateLabel)}
    </div>
  `;

  // Prompt block: rendered prompt in a preformatted block.
  const promptBody = r.prompt_rendered
    ? `<pre class="provenance-pre">${escapeHtml(r.prompt_rendered)}</pre>`
    : '<p class="detail-note">Nincs rögzített prompt.</p>';

  // Raw response block.
  const responseBody = r.raw_response
    ? `<pre class="provenance-pre">${escapeHtml(r.raw_response)}</pre>`
    : '<p class="detail-note">Nincs rögzített nyers válasz.</p>';

  // Experimental settings: permutation, seed, temperature, model, version, provider.
  const permutationText = decodePermutation(permutation, options);
  const settingsBody = `
    <div class="detail-grid">
      ${detailField('Opciósorrend', permutationText)}
      ${detailField('Seed', r.seed)}
      ${detailField('Hőmérséklet', r.temperature)}
      ${detailField('Kért modell', r.model_requested)}
      ${detailField('Kiszolgáló modellverzió', r.model_version)}
      ${detailField('Szolgáltató', r.provider)}
    </div>
  `;

  // Cost and timing.
  const costBody = `
    <div class="detail-grid">
      ${detailField('Prompt tokenek', orDash(r.prompt_tokens, formatNumber))}
      ${detailField('Completion tokenek', orDash(r.completion_tokens, formatNumber))}
      ${detailField('Cached tokenek', orDash(r.cached_tokens, formatNumber))}
      ${detailField('Költség (USD)', orDash(r.cost_usd, formatCost))}
      ${detailField('Latencia (ms)', orDash(r.latency_ms, formatNumber))}
      ${detailField('Időbélyeg', formatDateTime(r.created_at))}
    </div>
  `;

  // Assemble sections.
  return (
    provenanceSection('Válasz összefoglalása', summaryBody) +
    provenanceSection('A modellnek elküldött prompt', promptBody) +
    provenanceSection('Nyers modellválasz', responseBody) +
    provenanceSection('Kísérleti beállítások', settingsBody) +
    provenanceSection('Költség és idő', costBody)
  );
}

/**
 * Renders a per-persona transcript of a complete run.
 * Input: array of response rows (all from the same run, sorted by created_at).
 * Groups by persona_name (keeping first-seen order), renders one card per exchange.
 * Each card shows: question, answer, per-exchange settings (seed, permutation, model).
 * Includes a methodological note explaining that exchanges were independent
 * single-turn calls with no context carry-over.
 */
/** Local section helper: provenance.js must not depend on detail.js load order. */
function provenanceSection(title, body) {
  return `<div class="detail-section"><h3>${escapeHtml(title)}</h3>${body}</div>`;
}

/** Exchanges rendered per persona before the list is cut short. */
const TRANSCRIPT_LIMIT = 40;

function renderTranscript(responses) {
  if (!responses || responses.length === 0) {
    return '<p class="detail-note">Nincs megjeleníthető válasz.</p>';
  }

  // Methodological note: exchanges are independent, persona has no memory.
  const methodNote = `
    <div class="detail-note detail-note-warning">
      Ez NEM beszélgetés. Az alábbi kérdés–válasz párok egymástól függetlenek: minden
      kérdés friss kontextusban ment ki, a perszóna nem emlékezett a korábbi válaszaira.
      Ez szándékos — így kerüljük el a carryover/priming torzítást.
      A sorrend csak a rögzítés sorrendje — nem egy beszélgetés menete.
    </div>
  `;

  // Group responses by persona_name, keeping first-seen order.
  // Grouped by persona ID, not by name: personas are versioned snapshots and two
  // versions share a name, so grouping by name would merge distinct subjects.
  // A Map also survives persona names like "constructor" or "__proto__".
  const groups = new Map();
  for (const resp of responses) {
    const key = resp.persona_id || resp.persona_name || '—';
    if (!groups.has(key)) groups.set(key, { name: resp.persona_name || '—', responses: [] });
    groups.get(key).responses.push(resp);
  }
  const personas = [...groups.values()];

  // Render each persona group.
  const personaSections = personas
    .map((group) => {
      const total = group.responses.length;
      const shown = group.responses.slice(0, TRANSCRIPT_LIMIT);
      const personaTitle = `${group.name} (${total} válasz)`;
      const cutNote =
        total > shown.length
          ? `<p class="detail-note">Az első ${shown.length} válasz látszik a ${total}-ból. A teljes lista a Válaszok fülön és a CSV-exportban érhető el.</p>`
          : '';
      const cardBody = shown
        .map((resp, i) => {
          // Parse options for answerLabel.
          let options = [];
          try {
            if (resp.options_json) options = JSON.parse(resp.options_json);
          } catch (e) {
            // Empty options.
          }

          const answerText = answerLabel(
            resp.parsed_answer,
            options,
            resp.elicitation_mode === 'multi_choice'
          );
          const permutationText = decodePermutation(
            safeParse(resp.permutation_json),
            options
          );

          return `
            <div class="transcript-card" data-response-id="${escapeHtml(resp.id)}" role="button" tabindex="0"
                 title="Kattints a válasz teljes provenienciájáért: pontos prompt, nyers kimenet, beállítások.">
              <div class="transcript-card-number">${i + 1}.</div>
              <div class="transcript-card-content">
                <div class="transcript-card-question">${escapeHtml(resp.question_text)}</div>
                <div class="transcript-card-answer">${escapeHtml(answerText)}</div>
                <div class="transcript-card-meta">
                  Állapot: ${escapeHtml(responseState(resp))} •
                  Seed: ${escapeHtml(resp.seed === null || resp.seed === undefined ? '—' : resp.seed)} •
                  Rotáció: ${escapeHtml(permutationText)} •
                  Modellverzió: ${escapeHtml(resp.model_version || '—')}
                </div>
              </div>
            </div>
          `;
        })
        .join('');

      return provenanceSection(personaTitle, cutNote + cardBody);
    })
    .join('');

  return methodNote + personaSections;
}

/**
 * Decodes a permutation array (indexes) into readable option text.
 * Example input: [2, 0, 1] with options ['Bolt', 'Hírlevél', 'Plakát']
 * Output: "2. Plakát → 0. Bolt → 1. Hírlevél"
 * If options are missing or permutation is incomplete, falls back to raw indexes.
 */
function decodePermutation(permutation, options) {
  if (!Array.isArray(permutation) || permutation.length === 0) {
    return '—';
  }

  if (!Array.isArray(options) || options.length === 0) {
    // Fall back to raw indexes.
    return permutation.map((idx, pos) => `${pos + 1}. ${idx}`).join(' → ');
  }

  // Map each index to its option text, or fall back to the raw index.
  const labels = permutation.map((idx, pos) => {
    const text = options[idx] !== undefined ? options[idx] : idx;
    return `${pos + 1}. ${text}`;
  });

  return labels.join(' → ');
}

/**
 * Safe JSON parse: returns empty array on error.
 */
function safeParse(json) {
  try {
    return json ? JSON.parse(json) : [];
  } catch (e) {
    return [];
  }
}
