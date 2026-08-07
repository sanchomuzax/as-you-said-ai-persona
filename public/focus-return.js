// Focus return for the detail views (issue #12).
//
// Opening a detail moves focus into the detail heading, which is right — but on
// close the focus used to land back at the top of the document, so a keyboard
// user had to tab through the whole list again to get where they were.

let lastTriggerSelector = null;
// Code-review defect #2: the sidebar and the overview now render rows that
// carry the SAME data-entity-id / data-run-card values as the real lists
// (#personasList, #runsList), earlier in document order. A plain
// document.querySelector always matches the FIRST such row — the sidebar/
// overview copy, or (worse) a node inside a display:none pane, which a real
// browser cannot focus at all (focus silently falls to <body>). The CONTAINER
// the trigger was clicked in is remembered alongside the id, so restore can
// scope its lookup to that same list and never cross into a duplicate.
let lastTriggerContainer = null;

/**
 * A SELECTOR is remembered, not the element: the lists are re-rendered while a
 * detail is open (a run's progress keeps updating), so the node that was clicked
 * is usually gone by the time the view closes. The selector finds its
 * replacement; a remembered node would silently fail to take focus.
 *
 * `container` should be the list element the trigger row lives in (e.g. the
 * element the delegated click listener is attached to). It stays in the DOM
 * across a re-render (only its innerHTML is replaced), so scoping the lookup
 * to it is safe and disambiguates identical ids rendered elsewhere.
 */
function rememberDetailTrigger(attribute, id, container) {
  const value = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(String(id)) : String(id);
  lastTriggerSelector = `[${attribute}="${value}"]`;
  lastTriggerContainer = container || null;
}

function restoreDetailFocus() {
  const selector = lastTriggerSelector;
  const container = lastTriggerContainer;
  lastTriggerSelector = null;
  lastTriggerContainer = null;
  if (!selector) return;
  const scope = container && typeof container.querySelector === 'function' ? container : document;
  const target = scope.querySelector(selector);
  if (target && typeof target.focus === 'function') target.focus();
}
