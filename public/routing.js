// Hash routing: #<tab> for a list, #<tab>/<id> for a detail view.
// Pure functions (no DOM access) so the route table is unit-testable.

const VALID_TABS = ['projects', 'personas', 'questionnaires', 'runs', 'interviews'];
const DETAIL_HASH = /^(projects|personas|questionnaires|runs|interviews)\/(.+)$/;

const EMPTY_ROUTE = { tab: 'projects', runId: null, entityId: null, interviewId: null };

function parseHash(hash) {
  const value = String(hash || '').replace(/^#/, '');
  if (!value) return { ...EMPTY_ROUTE };

  const detail = value.match(DETAIL_HASH);
  if (detail) {
    const tab = detail[1];
    const id = decodeURIComponent(detail[2]);
    // Runs and interviews have their own detail views; the rest share the
    // generic entity view, so they are told apart here rather than at every
    // call site.
    if (tab === 'runs') return { ...EMPTY_ROUTE, tab: 'runs', runId: id };
    if (tab === 'interviews') return { ...EMPTY_ROUTE, tab: 'interviews', interviewId: id };
    return { ...EMPTY_ROUTE, tab, entityId: id };
  }
  if (VALID_TABS.includes(value)) return { ...EMPTY_ROUTE, tab: value };
  return { ...EMPTY_ROUTE };
}

function buildHash(tab, detailId) {
  return detailId ? '#' + tab + '/' + encodeURIComponent(detailId) : '#' + tab;
}
