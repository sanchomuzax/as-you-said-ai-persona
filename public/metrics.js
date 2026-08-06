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
  modelVersion: 'A szolgáltató által ténylegesen kiszolgáló modellverzió (model pinning ellenőrzéshez rögzítjük).',
  validFlag: '✓ érvényes válasz · — tartózkodás (bizonyítékhézag) · ✗ nem értelmezhető kimenet'
};

function statusLabel(status) {
  return STATUS_LABELS[status] || status || '—';
}

function statusTooltip(status) {
  return STATUS_TOOLTIPS[status] || '';
}

/** Chip helper: `title` is always escaped, since tooltips end up in an attribute. */
function chip(className, label, tooltip) {
  const title = tooltip ? ` title="${escapeHtml(tooltip)}"` : '';
  return `<span class="${className}"${title}>${escapeHtml(label)}</span>`;
}

/**
 * Metric chips for one question. Zero-valued abstain/invalid chips are omitted:
 * a "0" chip is noise, and hiding it makes a real evidentiary gap stand out.
 */
function renderMetricChips(question) {
  const chips = [];
  const pc = question.positionConsistency;
  const rs = question.repetitionStability;

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
  chips.push(chip('stat-chip', formatCost(stats.costUsd) + ' USD', TOOLTIPS.cost));
  if (stats.avgLatencyMs) {
    chips.push(chip('stat-chip', formatNumber(Math.round(stats.avgLatencyMs)) + ' ms/válasz', TOOLTIPS.latency));
  }
  return chips.join('');
}
