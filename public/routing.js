// Hash routing: #<tab> for a list, #<tab>/<id> for a detail view.
// Pure functions (no DOM access) so the route table is unit-testable.

const VALID_TABS = ['projects', 'personas', 'questionnaires', 'runs'];
const DETAIL_HASH = /^(projects|personas|questionnaires|runs)\/(.+)$/;

function parseHash(hash) {
  const value = String(hash || '').replace(/^#/, '');
  if (!value) return { tab: 'projects', runId: null, entityId: null };

  const detail = value.match(DETAIL_HASH);
  if (detail) {
    const tab = detail[1];
    const id = decodeURIComponent(detail[2]);
    return tab === 'runs'
      ? { tab: 'runs', runId: id, entityId: null }
      : { tab, runId: null, entityId: id };
  }
  if (VALID_TABS.includes(value)) return { tab: value, runId: null, entityId: null };
  return { tab: 'projects', runId: null, entityId: null };
}

function buildHash(tab, detailId) {
  return detailId ? '#' + tab + '/' + encodeURIComponent(detailId) : '#' + tab;
}
