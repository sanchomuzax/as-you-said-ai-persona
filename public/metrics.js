// Research-metric labels, tooltips and chip rendering.
// A research UI is only credible if its indicators explain themselves, so every
// metric shown carries a hover explanation (issue #2). No DOM access: unit-tested
// without a browser environment.

const STATUS_LABELS = {
  pending: 'Függőben',
  running: 'Fut',
  paused: 'Szüneteltetve',
  completed: 'Kész',
  budget_exhausted: 'Keret elfogyott',
  stopped: 'Leállítva',
  failed: 'Hiba'
};

const STATUS_TOOLTIPS = {
  pending: 'A futtatás létrejött, de még nem indult el modellhívás.',
  running: 'A futtatás folyamatban van: a perszónák válaszai most készülnek.',
  paused: 'Szüneteltetve — a már rögzített cellák megmaradnak, a folytatás onnan veszi fel a fonalat.',
  completed: 'Minden cella (perszóna × kérdés × rotáció × seed) lefutott.',
  budget_exhausted:
    'A token-keret elfogyott, ezért a szerver leállította a futtatást. A keret emelése után a futtatás folytatható.',
  stopped: 'A futtatást kézzel állították le; az addigi válaszok megmaradtak.',
  failed: 'A futtatás hibára futott. A már rögzített válaszok megmaradtak, a futtatás újraindítható.'
};

const TOOLTIPS = {
  positionConsistency:
    'Pozíció-konzisztencia (PC): a topválasz hányszor azonos az opciók eltérő sorrendjénél. 0.7 alatt a kérdés eredménye pozíció-érzékeny, nem megbízható.',
  repetitionStability:
    'Ismétlési stabilitás (RS): azonos beállítás mellett, eltérő seeddel hányszor azonos a topválasz. Alacsony érték: a válasz véletlen ingadozásra érzékeny.',
  positionWarning:
    'A topválasz megváltozott az opciók sorrendjével (PC < 0.7), ezért ez az eredmény sorrendi hatást tükröz, nem valós preferenciát — döntéshez nem használható.',
  stabilityWarning:
    'A topválasz seedenként változott (RS < 0.7): a válasz nem stabil, ismétléskor mást adna a modell.',
  abstain:
    'Tartózkodás: a perszóna jelezte, hogy a profilja alapján nincs megalapozott válasza — ez nem hiba, hanem tudáshatár (bizonyítékhézag).',
  abstainRate: 'A tartózkodó válaszok aránya. Nem hibaarány: azt mutatja, mely témákban nincs a perszónáknak megalapozott válasza.',
  invalid:
    'Nem értelmezhető modellkimenet (hiányzó vagy hibás eloszlás-JSON). A rekord megmarad — az arány maga is minőségi mutató; a néma eldobás mintavételi torzítást okozna.',
  invalidRate:
    'Az érvénytelen válaszok aránya az összes válaszon belül. 10% felett a modell alkalmassága megkérdőjelezhető ehhez a feladathoz.',
  cells:
    'Cellák: perszóna × kérdés × opció-rotáció × seed. A kész/összes arány a futtatás előrehaladása.',
  tokens: 'A futtatás által elhasznált tokenek száma (prompt + completion), a szerveroldali token-ledger alapján.',
  cost: 'Becsült költség USD-ben, az OpenRouter által jelentett használat alapján.',
  latency: 'Átlagos válaszidő modellhívásonként, ezredmásodpercben.',
  budgetBar:
    'Globális token-keret: az összes futtatás eddigi tokenfogyasztása a beállított kerethez képest. A keret elérésekor a szerver leállítja a futtatásokat.',
  totalResponses: 'A futtatás során rögzített modellválaszok száma (az érvényteleneket és a tartózkodásokat is beleértve).',
  topAnswer: 'A perszóna legnagyobb valószínűséget kapott válaszopciója az átlagolt eloszlás alapján.',
  distribution:
    'Style C elicitáció: a perszóna nem egy választ ad, hanem valószínűség-eloszlást az opciókra. Az oszlopok az átlagolt eloszlást mutatják.',
  seed: 'A modellhíváshoz használt seed. Ugyanaz a kérdés több seeddel megy ki, így mérhető az ismétlési stabilitás.',
  modelVersion:
    'A ténylegesen kiszolgáló modellverzió és szolgáltató (model pinning). Ugyanazt a modellt az OpenRouter több szolgáltatóhoz is irányíthatja, eltérő kvantálással és cache-viselkedéssel — ezért a szolgáltatót is rögzítjük.',
  evaluationModel:
    'A kiértékelést készítő modell verziója.',
  validFlag: '✓ érvényes válasz · — tartózkodás (bizonyítékhézag) · ✗ nem értelmezhető kimenet',
  multiChoice:
    'Többválaszos kérdés: az opciók függetlenek, mindegyikhez külön 0–1 kiválasztási valószínűség tartozik. A számok NEM összegződnek 100%-ra, és nem hasonlíthatók közvetlenül egyválaszos kérdés eloszlásához.',
  singleChoice:
    'Egyválaszos kérdés: az opciók kizárják egymást, a valószínűségek 100%-ra összegződnek (Style C eloszlás).',
  legacyElicitation:
    'Régi elicitationnal készült válaszok: ezek a többválaszos kérdést is 100%-ra normalizált eloszlásként kérdezték le, ezért mást mérnek. Az aggregátumból kihagyva — az összehasonlíthatóság érdekében a kérdést újra kell futtatni.',
  providerSpread:
    'Ezt a futtatást több szolgáltató szolgálta ki ugyanazzal a modell-azonosítóval. A szolgáltatók eltérő kvantálással futtatják a modellt, ezért a válaszok közti eltérés egy része routingból ered, nem a perszónából vagy a seedből — az ismétlési stabilitást (RS) ez rontja. Új futtatásnál a szolgáltató rögzíthető.',
  providerSingle: 'A futtatást végig ugyanaz a szolgáltató szolgálta ki, tehát a modellverzió mellett a futtatókörnyezet is állandó volt.',
  baselineArm:
    'Kontroll-kar: ugyanez a kérdés perszóna NÉLKÜL, ugyanazzal a sablonnal, szolgáltatóval és időpontban. Enélkül nem lehet megkülönböztetni a perszóna hatását a modell alapértelmezett válaszától.',
  personaEffect:
    'Perszóna-hatás: a perszóna eloszlásának Jensen–Shannon-távolsága a kontroll-kartól (0 = ugyanaz, 1 = teljesen más). A kontroll-kar saját seedjei közti ingadozás adja a zajszintet; ha a divergencia ennél kisebb, a perszóna nem térítette el a modellt.',
  duplicateCells:
    'Ismételten rögzített cellák: párhuzamos futtató-hurkok miatt ugyanaz a cella (perszóna × kérdés × rotáció × seed) többször is lefutott. Az elemzés cellánként az első rögzítést használja, a többi megmarad a naplóban ismételt mérésként — az aggregátumot tehát nem torzítják, de a nyers sorszám nagyobb az egyedi celláknál.',
  support:
    'Opciónkénti támogatottság: az adott opció átlagos kiválasztási valószínűsége a perszónák válaszaiban. Többválaszos kérdésnél az értékek összege meghaladhatja a 100%-ot.',
  cache:
    'Prompt-gyorsítótár (prompt cache): a prompt-tokenek ekkora része a szolgáltató gyorsítótárából érkezett, a normál ár nagyjából tizedéért — a tényleges költség tehát alacsonyabb, mint amit a nyers tokenszám sugall. A cache automatikusan épül fel az azonos prompt-előtaggal ismételt hívásoknál.',
  partialEvaluation:
    'Részeredmény: a futtatás még nem fejeződött be a kiértékelés készítésekor. A stabilitási mutatók (PC/RS) és az arányok még változhatnak.'
};

function statusLabel(status) {
  return STATUS_LABELS[status] || status || '—';
}

function statusTooltip(status) {
  return STATUS_TOOLTIPS[status] || '';
}

/**
 * Chip helper: `title` is always escaped, since tooltips end up in an attribute.
 *
 * A chip that carries an explanation also becomes focusable and gets the
 * explanation as its accessible name. The metric explanations are the substance
 * of this UI, and a hover-only `title` reaches neither a keyboard user nor a
 * touch screen. A chip WITHOUT an explanation stays out of the tab order — a
 * focus stop that reveals nothing is noise.
 */
function chip(className, label, tooltip) {
  if (!tooltip) return `<span class="${className}">${escapeHtml(label)}</span>`;
  return (
    `<span class="${className} chip-explained" title="${escapeHtml(tooltip)}" tabindex="0" role="note"` +
    ` aria-label="${escapeHtml(label)} — ${escapeHtml(tooltip)}">${escapeHtml(label)}</span>`
  );
}

/**
 * Metric chips for one question. Zero-valued abstain/invalid chips are omitted:
 * a "0" chip is noise, and hiding it makes a real evidentiary gap stand out.
 */
function renderMetricChips(question) {
  const chips = [];
  const pc = question.positionConsistency;
  const rs = question.repetitionStability;

  if (question.elicitationMode === 'multi_choice') {
    chips.push(chip('metric-chip metric-chip-info', '☑ Többválaszos', TOOLTIPS.multiChoice));
  }
  if (question.legacyElicitationCount) {
    chips.push(
      chip(
        'metric-chip metric-chip-warning',
        '⚠ régi elicitation: ' + formatNumber(question.legacyElicitationCount) + ' válasz kihagyva',
        TOOLTIPS.legacyElicitation
      )
    );
  }

  if (pc !== undefined && pc !== null) {
    chips.push(chip('metric-chip', 'PC ' + formatMetric(pc), TOOLTIPS.positionConsistency));
    if (pc < 0.7) {
      chips.push(chip('metric-chip metric-chip-warning', '⚠ pozíció-érzékeny — nem megbízható', TOOLTIPS.positionWarning));
    }
  }
  if (rs !== undefined && rs !== null) {
    chips.push(chip('metric-chip', 'RS ' + formatMetric(rs), TOOLTIPS.repetitionStability));
    if (rs < 0.7) {
      chips.push(chip('metric-chip metric-chip-warning', '⚠ instabil', TOOLTIPS.stabilityWarning));
    }
  }
  if (question.abstainCount) {
    chips.push(chip('metric-chip metric-chip-info', '🔍 Tartózkodás: ' + formatNumber(question.abstainCount), TOOLTIPS.abstain));
  }
  if (question.invalidCount) {
    chips.push(chip('metric-chip metric-chip-danger', 'Érvénytelen: ' + formatNumber(question.invalidCount), TOOLTIPS.invalid));
  }
  return chips.join('');
}

/**
 * Summary chips for a whole run (card and detail header). Zero invalid/abstain
 * counts are omitted for the same reason as above; progress, tokens and cost are
 * always shown because they describe the run itself, not an anomaly.
 */
function runStatChips(stats) {
  const chips = [
    chip('stat-chip', formatNumber(stats.done) + '/' + formatNumber(stats.totalCells) + ' cella', TOOLTIPS.cells)
  ];
  if (stats.invalid) {
    chips.push(
      chip('stat-chip' + (stats.invPct > 10 ? ' stat-chip-danger' : ''), 'Érvénytelen: ' + formatNumber(stats.invalid), TOOLTIPS.invalid)
    );
  }
  if (stats.abstained) {
    chips.push(chip('stat-chip', 'Tartózkodás: ' + formatNumber(stats.abstained), TOOLTIPS.abstain));
  }
  chips.push(chip('stat-chip', formatNumber(stats.totalTokens) + ' token', TOOLTIPS.tokens));
  const cacheChip = renderCacheChip(stats);
  if (cacheChip) chips.push(cacheChip);
  chips.push(chip('stat-chip', formatCost(stats.costUsd) + ' USD', TOOLTIPS.cost));
  if (stats.avgLatencyMs) {
    chips.push(chip('stat-chip', formatNumber(Math.round(stats.avgLatencyMs)) + ' ms/válasz', TOOLTIPS.latency));
  }
  return chips.join('');
}

/**
 * When every response to a multi-select question predates the elicitation fix,
 * the aggregate would be all zeros — an empty chart reads as "no support", which
 * is a different (and false) claim. Say what actually happened instead.
 */
function renderLegacyOnlyNotice(question) {
  const legacy = question.legacyElicitationCount || 0;
  if (legacy === 0 || (question.aggregatedResponseCount || 0) > 0) return '';
  return `<p class="detail-note detail-note-warning">Ehhez a kérdéshez csak a régi, hibás elicitationnal készült válasz van (${formatNumber(legacy)} db), ezért nincs mit aggregálni. A számokhoz a kérdést újra kell futtatni — a régi válaszok megmaradnak a naplóban.</p>`;
}

/**
 * Prompt cache hit indicator. Shows percentage and token count only when
 * both cachedTokens and promptTokens are present and truthy (zero cache is noise).
 */
function renderCacheChip(stats) {
  if (!stats.cachedTokens || !stats.promptTokens) return '';
  const percent = Math.round((stats.cachedTokens / stats.promptTokens) * 100);
  const label = `⚡ cache: ${percent}% (${formatNumber(stats.cachedTokens)} token)`;
  return chip('stat-chip', label, TOOLTIPS.cache);
}

/**
 * Renders a responses table model cell with version and optional provider tag.
 * Escapes all output to prevent injection via model_version or provider names.
 */
function renderModelCell(response) {
  if (!response) return escapeHtml('—');
  const modelVersion = response.model_version || '—';
  const provider = response.provider;
  const tooltipText = provider
    ? `Kiszolgáló szolgáltató: ${provider}`
    : 'A szolgáltató nincs rögzítve ennél a válasznál.';
  const providerHtml = provider ? ` <span class="provider-tag">${escapeHtml(provider)}</span>` : '';
  return `<span title="${escapeHtml(tooltipText)}">${escapeHtml(modelVersion)}${providerHtml}</span>`;
}

/**
 * Marks an evaluation produced while the run was still incomplete.
 * Returns empty string when run_status is missing or 'completed'.
 * When done_cells/total_cells are both present and valid, includes them in the tooltip.
 * Falls back to generic tooltip if counts are falsy, null/undefined, or contradictory.
 */
function renderPartialEvaluationChip(evaluation) {
  if (!evaluation.run_status || evaluation.run_status === 'completed') return '';
  let tooltip = TOOLTIPS.partialEvaluation;
  // Both counts must exist, be non-null, finite, non-negative, and logically consistent
  if (
    evaluation.done_cells != null && evaluation.total_cells != null &&
    Number.isFinite(evaluation.done_cells) && Number.isFinite(evaluation.total_cells) &&
    evaluation.total_cells > 0 && evaluation.done_cells >= 0 &&
    evaluation.done_cells <= evaluation.total_cells
  ) {
    tooltip = `A futtatás még nem fejeződött be a kiértékelés készítésekor: ${formatNumber(evaluation.total_cells)} cellából ${formatNumber(evaluation.done_cells)} válasz volt rögzítve. A stabilitási mutatók (PC/RS) és az arányok még változhatnak.`;
  }
  return chip('metric-chip metric-chip-warning', '⚠ Részeredmény', tooltip);
}

/**
 * Routing spread is a reproducibility signal, not a cost one: one model id served
 * by several providers means several implementations answered the same question.
 */
function renderProviderChip(providers) {
  const list = Array.isArray(providers) ? providers : [];
  if (list.length === 0) return '';
  if (list.length === 1) return chip('stat-chip', 'szolgáltató: ' + list[0].provider, TOOLTIPS.providerSingle);
  const names = list.map(p => p.provider + ' (' + formatNumber(p.count) + ')').join(', ');
  return chip(
    'stat-chip stat-chip-danger',
    '⚠ ' + formatNumber(list.length) + ' szolgáltató',
    TOOLTIPS.providerSpread + ' Megoszlás: ' + names + '.'
  );
}

/** Duplicated cells are a data-collection anomaly: name it where results are read. */
function renderDuplicateNotice(results) {
  const duplicates = (results && results.duplicateResponseCount) || 0;
  if (duplicates === 0) return '';
  return chip('stat-chip stat-chip-danger', '⚠ ismételt cella: ' + formatNumber(duplicates), TOOLTIPS.duplicateCells);
}
