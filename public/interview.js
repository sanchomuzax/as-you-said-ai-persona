// Interview mode rendering. Pure string builders (no DOM access) so they stay
// unit-testable; interview-view.js does the data loading and click wiring.
// All interpolated values go through escapeHtml — these render user- and
// model-supplied text.

/**
 * Shown above every interview. The interview is memory-carrying by design, which
 * is exactly what makes it unusable as measurement: the wording must not leave
 * room for reading a conversation as evidence.
 */
const INTERVIEW_DISCLAIMER =
  'Feltáró beszélgetés, nem mérés. A perszóna itt emlékszik az előző fordulókra, ezért a válaszok egymást is befolyásolják — ' +
  'a kimenet hipotézis, amit valódi emberi adaton kell ellenőrizni. Az interjúk külön táblában tárolódnak, és soha nem kerülnek be a futtatások eredményeibe — ' +
  'a token-keretet viszont közösen használják, ezért az interjúk fogyasztása is beleszámít a globális keretbe.';

/** In an audit view "unknown" must never be rendered as "zero" — and 0 is a real seed. */
function interviewValue(value, formatter) {
  if (value === null || value === undefined || value === '') return '—';
  return formatter ? formatter(value) : String(value);
}

/**
 * The recorded provenance of one persona turn. Researcher turns carry no model
 * call, so they get nothing: an empty metadata row would suggest a missing
 * measurement rather than a question typed by a human.
 */
function renderInterviewTurnMeta(message) {
  if (!message || message.role !== 'persona') return '';
  const parts = [
    ['Modell', interviewValue(message.model_version)],
    ['Szolgáltató', interviewValue(message.provider)],
    ['Temp.', interviewValue(message.temperature)],
    ['Seed', interviewValue(message.seed)],
    ['Token', `${interviewValue(message.prompt_tokens)} / ${interviewValue(message.completion_tokens)}`],
    ['Költség', interviewValue(message.cost_usd, formatCost)],
    ['Késleltetés', interviewValue(message.latency_ms, (v) => `${formatNumber(v)} ms`)]
  ];
  return `<div class="interview-turn-meta">${parts
    .map(([label, value]) => `<span><span class="meta-label">${escapeHtml(label)}:</span> ${escapeHtml(value)}</span>`)
    .join('')}</div>`;
}

/**
 * SQLite has no boolean type: `abstained` arrives as 1/0, so it is checked for
 * truthiness. An abstention is an evidence gap about what the profile supports —
 * never an error, and never called one on screen.
 */
function interviewAbstentionChip(message) {
  if (!message.abstained) return '';
  return '<span class="chip chip-warning" title="A perszóna jelezte, hogy a profilja nem ad alapot a válaszra. Ez a perszóna lefedettségéről szóló megállapítás, nem hiba.">bizonyítékhézag</span>';
}

function renderInterviewTurn(message) {
  const isPersona = message.role === 'persona';
  const speaker = isPersona ? 'Perszóna' : 'Kutató';
  // Only persona turns have a model call behind them, so only those open a
  // provenance panel — and they must be reachable from the keyboard too.
  const openable = isPersona
    ? ' role="button" tabindex="0" aria-label="Forduló provenienciájának megnyitása"'
    : '';
  return `
    <div class="interview-turn interview-turn-${isPersona ? 'persona' : 'researcher'}" data-interview-message="${escapeHtml(message.id)}"${openable}>
      <div class="interview-turn-head">
        <span class="interview-speaker">${escapeHtml(speaker)}</span>
        ${interviewAbstentionChip(message)}
        <span class="interview-turn-time">${escapeHtml(formatDateTime(message.created_at))}</span>
      </div>
      <div class="interview-turn-body">${escapeHtml(message.content)}</div>
      ${renderInterviewTurnMeta(message)}
    </div>
  `;
}

function renderInterviewTranscript(messages) {
  if (!messages || messages.length === 0) {
    return '<p class="placeholder">Még nincs kérdés ebben az interjúban.</p>';
  }
  return messages.map(renderInterviewTurn).join('');
}

function interviewListItem(interview) {
  // Stored rows are single turns; a researcher question and its answer are one
  // exchange. Showing the row count would double every number the reader sees.
  const exchanges = Math.floor(Number(interview.turnCount || 0) / 2);
  const meta = [
    interview.personaName ? `Perszóna: ${interview.personaName}` : null,
    `${exchanges} kérdés–válasz`,
    interview.createdAt ? formatDateTime(interview.createdAt) : null
  ]
    .filter(Boolean)
    .join(' · ');
  return `
    <div class="list-item list-item-clickable" data-interview-id="${escapeHtml(interview.id)}"
         role="button" tabindex="0" aria-label="Interjú megnyitása: ${escapeHtml(interview.title)}">
      <div>
        <div class="list-item-title">${escapeHtml(interview.title)}</div>
        <div class="list-item-meta">${escapeHtml(meta)}</div>
      </div>
    </div>
  `;
}

/**
 * Full provenance of one interview turn: the exact conversation that was sent
 * and the untouched model output. The displayed answer strips the abstention
 * marker, so the raw output is the only place the marker survives — an audit
 * has to be able to see it.
 */
function renderInterviewTurnProvenance(message) {
  if (!message) return '<p class="detail-note">Nincs megjeleníthető adat.</p>';

  let sent = [];
  try {
    if (message.prompt_rendered) sent = JSON.parse(message.prompt_rendered);
  } catch (e) {
    sent = [];
  }

  const conversation = Array.isArray(sent) && sent.length > 0
    ? sent
        .map(
          (m) => `<div class="provenance-message"><span class="meta-label">${escapeHtml(m.role)}</span>
            <pre class="provenance-pre">${escapeHtml(m.content)}</pre></div>`
        )
        .join('')
    : '<p class="detail-note">A promptot ehhez a fordulóhoz nem rögzítettük.</p>';

  const facts = [
    ['Modell (kért)', interviewValue(message.model_requested)],
    ['Modellverzió', interviewValue(message.model_version)],
    ['Szolgáltató', interviewValue(message.provider)],
    ['Temperature', interviewValue(message.temperature)],
    ['Seed', interviewValue(message.seed)],
    ['Prompt tokenek', interviewValue(message.prompt_tokens)],
    ['Válasz tokenek', interviewValue(message.completion_tokens)],
    ['Gyorsítótárazott', interviewValue(message.cached_tokens)],
    ['Költség (USD)', interviewValue(message.cost_usd, formatCost)],
    ['Késleltetés', interviewValue(message.latency_ms, (v) => `${formatNumber(v)} ms`)],
    ['OpenRouter kérés-azonosító', interviewValue(message.openrouter_request_id)],
    ['Tartózkodás', message.abstained ? 'igen (bizonyítékhézag)' : 'nem']
  ];

  return `
    <p class="methodology-warning">Feltáró beszélgetés egy fordulója. A rögzített adatok a hívás
      visszakereséséhez kellenek; a válasz tartalma hipotézis, nem mérési eredmény.</p>
    <div class="detail-section"><h3>Elküldött beszélgetés</h3>${conversation}</div>
    <div class="detail-section"><h3>Nyers modellkimenet</h3>
      <pre class="provenance-pre">${escapeHtml(message.raw_response ?? '—')}</pre></div>
    <div class="detail-section"><h3>Kísérleti beállítások</h3>
      <div class="detail-grid">${facts
        .map(
          ([label, value]) =>
            `<div class="detail-field"><span class="detail-label">${escapeHtml(label)}</span>
             <span class="detail-value">${escapeHtml(value)}</span></div>`
        )
        .join('')}</div></div>
  `;
}
