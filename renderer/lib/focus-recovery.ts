// When the focused row of a list leaves the page (deleted, moved out, its
// folder closed), the browser drops focus on the document body and a keyboard
// user loses their place. Instead focus goes to the row that took its place
// (the next one), or the previous one when it was last, or the list's Tab
// stop, or the list itself.
// Focus that something else already took on purpose stays where it is.

/**
 * The row to focus once `removed` rows have left: the first row after the
 * last removed one that is still `available`, else the nearest one before
 * the first removed one, else null. `before` is the rows in screen order
 * from before the removal.
 */
export function focusAfterRemoval(
  before: readonly HTMLElement[],
  removed: ReadonlySet<HTMLElement>,
  available: (row: HTMLElement) => boolean,
): HTMLElement | null {
  const indexes = before.flatMap((row, index) => (removed.has(row) ? [index] : []));
  if (indexes.length === 0) return null;
  const first = indexes[0]!;
  const last = indexes[indexes.length - 1]!;
  for (let index = last + 1; index < before.length; index += 1) {
    const row = before[index]!;
    if (!removed.has(row) && available(row)) return row;
  }
  for (let index = first - 1; index >= 0; index -= 1) {
    const row = before[index]!;
    if (!removed.has(row) && available(row)) return row;
  }
  return null;
}

function focusLost(doc: Document): boolean {
  const active = doc.activeElement;
  return !active || active === doc.body || !active.isConnected;
}

/**
 * Keeps focus in `container` when the row holding it is removed. `rows` lists
 * the rows in screen order; `rowFor` names the row that owns a focused
 * element (the row itself, or a row's own ••• button). When no row from
 * before is left, `tabStop` (the list's current Tab stop) takes focus, else
 * the container, made focusable (`tabindex="-1"`) only until it loses focus so
 * a click on its empty space never focuses it. Returns the cleanup.
 */
export function watchFocusRecovery(
  container: HTMLElement,
  rows: () => HTMLElement[],
  rowFor: (target: Element) => HTMLElement | null,
  tabStop: () => HTMLElement | null = () => null,
): () => void {
  const doc = container.ownerDocument;
  let holder: HTMLElement | null = null;
  let snapshot: HTMLElement[] = [];

  const onFocusIn = (event: FocusEvent) => {
    const row = event.target instanceof Element ? rowFor(event.target) : null;
    if (!row) return;
    holder = row;
    snapshot = rows();
  };
  const onFocusOut = () => {
    // A row that left the page reports a blur too; only a move elsewhere lets go.
    queueMicrotask(() => {
      if (holder?.isConnected && !container.contains(doc.activeElement)) holder = null;
    });
  };
  const observer = new MutationObserver(() => {
    if (!holder) return;
    if (holder.isConnected) {
      snapshot = rows();
      return;
    }
    const lost = holder;
    holder = null;
    if (!focusLost(doc)) return;
    const listed = new Set(rows());
    const next = focusAfterRemoval(
      snapshot,
      new Set([lost]),
      (row) => row.isConnected && listed.has(row),
    );
    const stop = next ?? tabStop();
    if (stop) {
      stop.focus();
      return;
    }
    if (container.hasAttribute("tabindex")) {
      container.focus({ preventScroll: true });
      return;
    }
    container.setAttribute("tabindex", "-1");
    container.addEventListener("blur", () => container.removeAttribute("tabindex"), { once: true });
    container.focus({ preventScroll: true });
  });
  observer.observe(container, { childList: true, subtree: true });
  container.addEventListener("focusin", onFocusIn);
  container.addEventListener("focusout", onFocusOut);
  return () => {
    observer.disconnect();
    container.removeEventListener("focusin", onFocusIn);
    container.removeEventListener("focusout", onFocusOut);
  };
}
