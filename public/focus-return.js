// Focus return for the detail views (issue #12).
//
// Opening a detail moves focus into the detail heading, which is right — but on
// close the focus used to land back at the top of the document, so a keyboard
// user had to tab through the whole list again to get where they were.

let lastTriggerSelector = null;

/**
 * A SELECTOR is remembered, not the element: the lists are re-rendered while a
 * detail is open (a run's progress keeps updating), so the node that was clicked
 * is usually gone by the time the view closes. The selector finds its
 * replacement; a remembered node would silently fail to take focus.
 */
function rememberDetailTrigger(attribute, id) {
  const value = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(String(id)) : String(id);
  lastTriggerSelector = `[${attribute}="${value}"]`;
}

function restoreDetailFocus() {
  const selector = lastTriggerSelector;
  lastTriggerSelector = null;
  if (!selector) return;
  const target = document.querySelector(selector);
  if (target && typeof target.focus === 'function') target.focus();
}
