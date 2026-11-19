/** How long the glide to a row takes: `--motion-large-duration`. */
const GLIDE_MS = 360;

const noop = () => {};

function scrollPortOf(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (/^(?:auto|scroll|overlay)$/u.test(getComputedStyle(node).overflowY)) return node;
  }
  return null;
}

/**
 * Scrolls `element` to the middle of its scrollport, gliding there unless `animate` is
 * false, and returns a function that stops the glide.
 *
 * Chromium can't stop its own smooth scroll from a later task: setting `scrollTop` while one
 * runs still lands the rest of it afterwards, so a page left mid-scroll ends up a few pixels
 * down. This glide writes `scrollTop` itself each frame, so stopping it (or anyone scrolling
 * the port meanwhile, a person included) leaves nothing in flight.
 */
export function glideIntoView(element: HTMLElement, { animate }: { animate: boolean }): () => void {
  const port = animate ? scrollPortOf(element) : null;
  if (!port) {
    element.scrollIntoView({ block: "center", behavior: "instant" });
    return noop;
  }
  // Chromium works out where the middle is (scroll padding, sticky edges); the port goes back
  // before anything paints and glides there instead.
  const from = port.scrollTop;
  element.scrollIntoView({ block: "center", behavior: "instant" });
  const to = port.scrollTop;
  port.scrollTop = from;
  if (to === from) return noop;

  let frame = 0;
  let start: number | undefined;
  let written = port.scrollTop;
  const step = (now: number) => {
    if (Math.abs(port.scrollTop - written) > 1) return;
    start ??= now;
    const progress = Math.min(1, (now - start) / GLIDE_MS);
    port.scrollTop = from + (to - from) * (1 - (1 - progress) ** 4);
    written = port.scrollTop;
    if (progress < 1) frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
  return () => cancelAnimationFrame(frame);
}
