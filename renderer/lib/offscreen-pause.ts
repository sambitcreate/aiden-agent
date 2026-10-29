// Pausing looping animations nobody can see.
//
// One shared IntersectionObserver marks each observed element `data-offscreen`
// while it is scrolled out of view, and one visibilitychange listener marks
// the root `data-document-hidden` while the window is hidden. styles.css pauses
// the looping animations (activity marks, working avatars, the thinking
// shimmer, the image scan) under those attributes, so a long transcript or a
// window behind other apps never repaints for nothing.

let sharedObserver: IntersectionObserver | null = null;
let watchedDocument: Document | null = null;

function visibilityObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === "undefined") return null;
  sharedObserver ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      entry.target.toggleAttribute("data-offscreen", !entry.isIntersecting);
    }
  });
  return sharedObserver;
}

/** Keep `data-document-hidden` on the root in step with the window, once per document. */
function watchDocumentVisibility(): void {
  if (typeof document === "undefined" || watchedDocument === document) return;
  const current = document;
  watchedDocument = current;
  const update = () =>
    current.documentElement.toggleAttribute(
      "data-document-hidden",
      current.visibilityState === "hidden",
    );
  update();
  current.addEventListener("visibilitychange", update);
}

/**
 * Pause an element's animations while it is scrolled out of view
 * (`data-offscreen`) or the window is hidden (`data-document-hidden` on the
 * root). Returns the cleanup.
 */
export function observeOffscreen(node: Element): () => void {
  watchDocumentVisibility();
  const observer = visibilityObserver();
  if (!observer) return () => undefined;
  observer.observe(node);
  return () => observer.unobserve(node);
}

/** `observeOffscreen` as a ref callback, for elements that only sometimes animate. */
export function pauseWhenUnseen(node: Element | null): (() => void) | undefined {
  return node ? observeOffscreen(node) : undefined;
}
