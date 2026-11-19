// Scrolls a row into view inside its scrolling list, honouring the list's
// scroll-padding, without scrolling the page or a dialog around the list the
// way `scrollIntoView` can.

/** The scroll offset that shows `start..start+size`, moving as little as possible. */
export function scrollToShow(
  scroll: number,
  viewport: number,
  start: number,
  size: number,
  before = 0,
  after = 0,
): number {
  if (start - before < scroll) return Math.max(0, start - before);
  if (start + size + after > scroll + viewport) return Math.max(0, start + size + after - viewport);
  return scroll;
}

/** Reveals `row` in its nearest scrolling ancestor, up to and including `stop`. */
export function revealInList(row: HTMLElement, stop?: HTMLElement | null): void {
  for (let node = row.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (/(auto|scroll)/u.test(style.overflowY) && node.scrollHeight > node.clientHeight) {
      const top =
        row.getBoundingClientRect().top - node.getBoundingClientRect().top - node.clientTop + node.scrollTop;
      const shown = scrollToShow(
        node.scrollTop,
        node.clientHeight,
        top,
        row.offsetHeight,
        parseFloat(style.scrollPaddingTop) || 0,
        parseFloat(style.scrollPaddingBottom) || 0,
      );
      // The last row's padding asks past the end, which would write on every move.
      const scrollTop = Math.min(shown, node.scrollHeight - node.clientHeight);
      if (scrollTop !== node.scrollTop) node.scrollTop = scrollTop;
      return;
    }
    if (node === stop) return;
  }
}
