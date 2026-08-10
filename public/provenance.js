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

/**
 * Inspector: Persona Provenance Card (docs/UI-DESIGN.md §"Becsúszó Inspector",
 * §6b, §7.5). Opened by clicking a response card (public/run-view.js's
 * wirePersonaCardOpening) — persona OR response, both route here, per the
 * spec. Reuses fetchPersonaCached/fetchRunResponsesCached (public/run-view.js)
 * so this never issues a fetch the card list didn't already need.
 */
async function openPersonaProvenancePanel(runId, personaId, responseId) {
  const panel = document.getElementById('provenancePanel');
  const body = document.getElementById('provenanceBody');
  const title = document.getElementById('provenancePanelTitle');
  if (title) title.textContent = 'Perszóna proveniencia';
  panel.style.display = 'block';
  body.innerHTML = '<p class="placeholder">Betöltés...</p>';
  if (!personaId) {
    body.innerHTML = '<p class="detail-note">Ehhez a válaszhoz nincs rögzítve perszóna-azonosító.</p>';
    return;
  }
  try {
    const [persona, runData] = await Promise.all([
      fetchPersonaCached(personaId),
      fetchRunResponsesCached(runId, false)
    ]);
    const responses = (runData && runData.responses) || [];
    const thisResponse = responses.find((r) => r.id === responseId) || null;
    const questionId = thisResponse ? thisResponse.question_id : null;
    // "Measured values FOR THIS QUESTION" (docs/UI-DESIGN.md's approved
    // Inspector copy) — scoped to the same persona+question pair across every
    // seed in this run, not the persona's whole run.
    const scoped = questionId
      ? responses.filter((r) => r.persona_id === personaId && r.question_id === questionId)
      : responses.filter((r) => r.persona_id === personaId);
    const total = scoped.length;
    const abstainCount = scoped.filter((r) => r.abstained).length;
    const invalidCount = scoped.filter((r) => !r.abstained && r.is_valid === 0).length;
    // The calibration profile is keyed by the run's CONFIGURED model id
    // (state.modelProfiles' `.model`, e.g. "openai/gpt-4o") — NOT by
    // `model_version`, which is the specific served snapshot string a
    // provider returned (e.g. "gpt-4o-2026-05-13") and essentially never
    // matches a profile key. The bulk /api/runs/:id response list does not
    // even carry `model_requested` (src/server.ts omits it there on
    // purpose); the run's own config_json is the real source of truth for
    // "which model was this run configured to call" — parsedRunConfig is
    // model-view.js's existing parser for exactly that field.
    const runConfig = runData && runData.run ? parsedRunConfig(runData.run) : null;
    const modelId = runConfig ? runConfig.model : null;
    const profile = modelId ? (state.modelProfiles || []).find((m) => m.model === modelId) : null;
    body.innerHTML = renderPersonaProvenanceCard(persona, {
      isGap: !!(thisResponse && thisResponse.abstained),
      questionText: thisResponse ? thisResponse.question_text : null,
      total,
      abstainCount,
      invalidCount,
      profile,
      // Display-only fact, distinct from the profile lookup above: the
      // actual served snapshot version for THIS response.
      modelLabel: thisResponse ? thisResponse.model_version || null : null
    });
  } catch (err) {
    body.innerHTML = `<p class="error-message">Perszóna proveniencia betöltése sikertelen: ${escapeHtml(err.message)}</p>`;
  }
}

/**
 * The card's content (docs/UI-DESIGN.md's approved Inspector copy, §6b/§7.5):
 * avatar/name/subtitle, an ALWAYS-neutral coverage badge (our personas have
 * no empirical grounding corpus — the green/amber states are unreachable by
 * design, and the topic Coverage lists are not rendered because there is no
 * data behind them), an Abstention Reason section (only when this card was
 * opened from an abstained response, numbers from this run's own records,
 * never invented), demographic chips, and a system-metadata table.
 */
function renderPersonaProvenanceCard(persona, ctx) {
  if (!persona) return '<p class="detail-note">Nincs megjeleníthető perszóna-adat.</p>';

  const initials = personaInitials(persona.name);
  // The rendering style select's own established labels (index.html's
  // #personaStyle options) — reused verbatim as the subtitle rather than
  // stacked with an extra noun ("... renderelés"), which read as an
  // awkward three-noun compound.
  const styleLabel = persona.renderingStyle === 'natural_language_sentence' ? 'Természetes nyelv' : 'Felsorolás profil';

  const header = `
    <div class="inspector-persona-header">
      <div class="inspector-persona-avatar${ctx.isGap ? ' inspector-persona-avatar-gap' : ''}" aria-hidden="true">${
        ctx.isGap ? '△' : escapeHtml(initials)
      }</div>
      <div class="inspector-persona-name">${escapeHtml(persona.name || '—')}</div>
      <div class="inspector-persona-subtitle">${escapeHtml(styleLabel)}</div>
    </div>
  `;

  // Coverage badge: ALWAYS the neutral "undocumented" state for our personas
  // (docs/UI-DESIGN.md §6b researcher's ruling: "final, not a stopgap"). The
  // green/amber grounding states and the per-topic Coverage lists are
  // deliberately absent — §7.5 forbids reintroducing them without real data.
  const coverage = `
    <div class="coverage-badge coverage-badge-undocumented">
      <span class="coverage-badge-icon" aria-hidden="true">🛡️</span>
      <div>
        <div class="coverage-badge-title">Lefedettség</div>
        <div class="coverage-badge-text">A lefedettség nincs dokumentálva. A perszóna demográfiai magja külső
          statisztikai forrásból származik, nem empirikus szöveges korpuszból — emiatt egyetlen témában sem
          tekinthető megalapozottnak.</div>
      </div>
    </div>
  `;

  // docs/UI-DESIGN.md's "Inspector panel — approved copy" section: "implement
  // verbatim (with real values substituted), because each element carries a
  // methodological commitment." Only the question text and the measured
  // numbers below are substituted — the explanatory sentence is unchanged.
  const measuredAt = ctx.profile && ctx.profile.profile && ctx.profile.profile.createdAt
    ? formatDateOnly(ctx.profile.profile.createdAt)
    : null;
  const profileLabel = ctx.profile
    ? (CALIBRATION_STATUS_LABELS[ctx.profile.status] || ctx.profile.status) + (measuredAt ? ` (${measuredAt})` : '')
    : 'nincs rögzítve ehhez a modellhez';
  const reasonSection = ctx.isGap
    ? `
    <div class="detail-section">
      <h3 class="inspector-section-title">Tartózkodás oka</h3>
      <p class="detail-text">A perszóna profilja nem tartalmaz a kérdés témájához${
        ctx.questionText ? ` („${escapeHtml(ctx.questionText)}”)` : ''
      } kapcsolódó attribútumot. A modell ezért explicit módon jelezte a tudáshatárát, ahelyett hogy tippelt volna.</p>
      <p class="detail-note" style="margin-top: 8px;">${
        ctx.total > 0
          ? `Mért értékek ennél a kérdésnél: tartózkodás ${escapeHtml(ctx.abstainCount)}/${escapeHtml(ctx.total)} válasz ·
             érvénytelen ${escapeHtml(ctx.invalidCount)}/${escapeHtml(ctx.total)} · a modell kalibrációs profilja:
             ${escapeHtml(profileLabel)}.`
          : 'Ehhez a kérdéshez nincs más rögzített válasz ebben a futtatásban, amivel az arányt mérni lehetne.'
      }</p>
    </div>
  `
    : '';

  const demoEntries = Object.entries(persona.demographics || {});
  const demoChips = demoEntries.length
    ? `<div class="demo-chip-row">${demoEntries
        .map(([k, v]) => `<span class="demo-chip">${escapeHtml(k)}: ${escapeHtml(String(v))}</span>`)
        .join('')}</div>`
    : '<p class="detail-note">Nincs rögzített demográfiai adat.</p>';
  const demoSection = `
    <div class="detail-section">
      <h3 class="inspector-section-title">Demográfia</h3>
      ${demoChips}
    </div>
  `;

  const metaRows = [
    ['Verzió', 'v' + escapeHtml(persona.version || 1) + (persona.createdAt ? ' (' + escapeHtml(formatDateTime(persona.createdAt)) + ')' : '')],
    ['Renderelési stílus', escapeHtml(styleLabel)]
  ];
  if (ctx.modelLabel) metaRows.push(['Modell ebben a válaszban', escapeHtml(ctx.modelLabel)]);
  const metaSection = `
    <div class="detail-section">
      <h3 class="inspector-section-title">Rendszer Metaadatok</h3>
      <ul class="inspector-meta-list">
        ${metaRows.map(([label, value]) => `<li><span>${escapeHtml(label)}</span><span class="inspector-meta-value">${value}</span></li>`).join('')}
      </ul>
    </div>
  `;

  return header + coverage + reasonSection + demoSection + metaSection;
}
