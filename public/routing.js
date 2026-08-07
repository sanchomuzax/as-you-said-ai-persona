// Hash routing: #<tab> for a list, #<tab>/<id> for a detail view.
// Pure functions (no DOM access) so the route table is unit-testable.

// 'overview' (issue #20) is a plain tab route like the rest here — it just has
// no detail sub-route of its own. The empty-hash DEFAULT stays 'projects'
// below: tests/frontend-routing.test.ts pins that contract for parseHash
// itself, so the overview-as-default behaviour is applied one layer up, in
// app.js's currentRoute(), instead of changing what this function returns for ''.
const VALID_TABS = ['overview', 'projects', 'personas', 'questionnaires', 'runs', 'interviews', 'models'];
const DETAIL_HASH = /^(projects|personas|questionnaires|runs|interviews|models)\/(.+)$/;

const EMPTY_ROUTE = { tab: 'projects', runId: null, entityId: null, interviewId: null, modelId: null };

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
    if (tab === 'models') return { ...EMPTY_ROUTE, tab: 'models', modelId: id };
    return { ...EMPTY_ROUTE, tab, entityId: id };
  }
  if (VALID_TABS.includes(value)) return { ...EMPTY_ROUTE, tab: value };
  return { ...EMPTY_ROUTE };
}

function buildHash(tab, detailId) {
  return detailId ? '#' + tab + '/' + encodeURIComponent(detailId) : '#' + tab;
}
