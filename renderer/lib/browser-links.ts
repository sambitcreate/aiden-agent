import type { BrowserCommand } from "../shared/browser";

/** Keep app navigation and non-web protocols with their existing handlers. */
export function browserLinkCommand(href: string, modifiers: { metaKey: boolean; ctrlKey: boolean }): BrowserCommand | null {
  if (/^https?:\/\//i.test(href)) {
    try {
      const url = new URL(href);
      if (!url.hostname) return null;
      return { action: "open_link", url: url.href, alternateTarget: modifiers.metaKey || modifiers.ctrlKey };
    } catch { return null; }
  }
  if (/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(href)) return null;
  const path = href.split(/[?#]/, 1)[0];
  if (!/\.(?:html?|pdf)$/i.test(path)) return null;
  try { return { action: "open_file", path: decodeURIComponent(path) }; } catch { return null; }
}
