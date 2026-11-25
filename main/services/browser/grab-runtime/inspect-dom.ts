import { rectInTopViewport, type ViewportRect } from "./hit-test.js";

export interface DomInspectionResult {
  tagName: string;
  domLabel: string;
  selector: string;
  role?: string;
  accessibleName?: string;
  htmlSnippet: string;
  textPreview?: string;
  attributes?: Record<string, string>;
  computedStyles?: Record<string, string>;
}

const MAX_SELECTOR_CHARS = 1024;
const MAX_HTML_CHARS = 4096;
const MAX_TEXT_CHARS = 1024;
const MAX_ATTRIBUTES = 20;
const MAX_ATTR_VALUE_CHARS = 512;
const MAX_HTML_DEPTH = 4;
const MAX_HTML_CHILDREN = 12;

const CURATED_STYLE_PROPS = [
  "display",
  "position",
  "width",
  "height",
  "padding",
  "margin",
  "gap",
  "flex-direction",
  "align-items",
  "justify-content",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "color",
  "background-color",
  "border-radius",
  "border",
  "opacity",
  "z-index",
] as const;

const SECRET_ATTR_PATTERN =
  /pass|secret|token|auth|api[_-]?key|cookie|session|credit|card|cvv|cvc|ssn|bearer|jwt|private/iu;

const CREDENTIAL_AUTOCOMPLETE_TOKENS = new Set([
  "current-password",
  "new-password",
  "one-time-code",
]);

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/gu, (ch) => `\\${ch}`);
}

export function isSensitiveDomElement(element: Element): boolean {
  const tag = (element.localName || element.tagName || "").toLowerCase();
  if (tag === "input") {
    const type = (element.getAttribute("type") ?? "").trim().toLowerCase();
    if (type === "password") return true;
  }
  const autocomplete = (element.getAttribute("autocomplete") ?? "").toLowerCase();
  if (autocomplete) {
    for (const token of autocomplete.split(/\s+/u)) {
      if (CREDENTIAL_AUTOCOMPLETE_TOKENS.has(token) || token.startsWith("cc-")) {
        return true;
      }
    }
  }
  return false;
}

/** Whether the element is, or wraps, a password, one-time-code or payment-card field. */
export function containsSensitiveField(element: Element): boolean {
  if (isSensitiveDomElement(element)) return true;
  let fields: NodeListOf<Element>;
  try {
    fields = element.querySelectorAll("input, [autocomplete]");
  } catch {
    return false;
  }
  for (let i = 0; i < fields.length && i < 500; i += 1) {
    const field = fields[i];
    if (field && isSensitiveDomElement(field)) return true;
  }
  return false;
}

function isDisallowedAttrName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "value" || /^on[a-z]/u.test(lower);
}

function sanitizeAttrValue(name: string, rawValue: string): string {
  if (SECRET_ATTR_PATTERN.test(name)) return "[redacted]";
  if (/^data:/iu.test(rawValue.trim()) && rawValue.length > 96) {
    const comma = rawValue.indexOf(",");
    const header = comma > 0 ? rawValue.slice(0, Math.min(comma, 48)) : "data:";
    return `${header},[truncated]`;
  }
  return rawValue.slice(0, MAX_ATTR_VALUE_CHARS);
}

function filteredClasses(element: Element): string[] {
  const raw = element.getAttribute("class") ?? "";
  return raw
    .split(/\s+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && token.length <= 48 && !/^(css|sc|emotion)-[a-z0-9]{5,}$/iu.test(token));
}

export function buildDomLabel(element: Element): string {
  const tag = (element.localName || element.tagName || "div").toLowerCase();
  const id = element.getAttribute("id")?.trim();
  if (id && id.length <= 40 && !/^\d+$/u.test(id)) {
    return `${tag}#${id}`.slice(0, 120);
  }
  const classes = filteredClasses(element).slice(0, 2);
  if (classes.length > 0) {
    return `${tag}.${classes.join(".")}`.slice(0, 120);
  }
  return tag.slice(0, 64);
}

/** Builds a Shadow-DOM-aware CSS selector (`host >> inner > .btn`). */
export function buildCssSelector(element: Element): string {
  const sections: string[] = [];
  let target: Element | null = element;
  let guard = 0;

  while (target && guard < 8) {
    guard += 1;
    const root: Node | null =
      typeof target.getRootNode === "function" ? target.getRootNode() : target.ownerDocument;
    const queryRoot =
      root && "querySelectorAll" in root ? (root as ParentNode) : target.ownerDocument;
    const pieces: string[] = [];

    for (let current: Element | null = target; current; current = current.parentElement) {
      const tag = (current.localName || current.tagName || "div").toLowerCase();
      const id = current.getAttribute("id")?.trim();
      if (id && queryRoot) {
        const escapedId = `#${cssEscape(id)}`;
        try {
          if (queryRoot.querySelectorAll(escapedId).length === 1) {
            pieces.unshift(escapedId);
            break;
          }
        } catch {
          // Fall through to path segment.
        }
      }

      const testId = current.getAttribute("data-testid")?.trim();
      if (testId && queryRoot) {
        const attrSelector = `[data-testid="${cssEscape(testId)}"]`;
        try {
          if (queryRoot.querySelectorAll(attrSelector).length === 1) {
            pieces.unshift(attrSelector);
            break;
          }
        } catch {
          // Fall through.
        }
      }

      const classes = filteredClasses(current).slice(0, 2);
      const classSuffix = classes.length > 0 ? `.${classes.map(cssEscape).join(".")}` : "";
      const parent: Element | null = current.parentElement;
      if (parent) {
        const sameTagSiblings = Array.from(parent.children).filter(
          (child) => (child.localName || child.tagName).toLowerCase() === tag,
        );
        if (sameTagSiblings.length > 1) {
          const index = sameTagSiblings.indexOf(current) + 1;
          pieces.unshift(`${cssEscape(tag)}${classSuffix}:nth-of-type(${index})`);
        } else {
          pieces.unshift(`${cssEscape(tag)}${classSuffix}`);
        }
      } else {
        pieces.unshift(`${cssEscape(tag)}${classSuffix}`);
      }
      if (pieces.length >= 8) break;
    }

    sections.unshift(pieces.join(" > "));
    if (typeof ShadowRoot !== "undefined" && root instanceof ShadowRoot && root.host) {
      target = root.host;
    } else {
      target = null;
    }
  }

  return sections.join(" >> ").slice(0, MAX_SELECTOR_CHARS) || (element.localName || "div").toLowerCase();
}

function implicitAriaRole(element: Element): string | undefined {
  const explicit = element.getAttribute("role")?.trim();
  if (explicit) return explicit.slice(0, 80);
  const tag = (element.localName || element.tagName || "").toLowerCase();
  if (tag === "button") return "button";
  if (tag === "a" && element.hasAttribute("href")) return "link";
  if (tag === "img") return "img";
  if (tag === "nav") return "navigation";
  if (tag === "main") return "main";
  if (tag === "header") return "banner";
  if (tag === "footer") return "contentinfo";
  if (tag === "form") return "form";
  if (tag === "textarea") return "textbox";
  if (tag === "select") return "combobox";
  if (tag === "input") {
    const type = (element.getAttribute("type") ?? "text").toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "submit" || type === "button" || type === "reset") return "button";
    return "textbox";
  }
  return undefined;
}

function extractAccessibleName(element: Element): string | undefined {
  if (isSensitiveDomElement(element)) return undefined;
  const ariaLabel = element.getAttribute("aria-label")?.trim();
  if (ariaLabel) return ariaLabel.slice(0, 256);

  const labelledBy = element.getAttribute("aria-labelledby")?.trim();
  if (labelledBy && element.ownerDocument) {
    const parts: string[] = [];
    for (const id of labelledBy.split(/\s+/u).slice(0, 4)) {
      const target = element.ownerDocument.getElementById(id);
      const text = target?.textContent?.replace(/\s+/gu, " ").trim();
      if (text) parts.push(text);
    }
    if (parts.length > 0) return parts.join(" ").slice(0, 256);
  }

  const alt = element.getAttribute("alt")?.trim();
  if (alt) return alt.slice(0, 256);

  const title = element.getAttribute("title")?.trim();
  if (title) return title.slice(0, 256);

  const tag = (element.localName || element.tagName || "").toLowerCase();
  if (tag === "button" || tag === "a" || tag === "summary") {
    const text = element.textContent?.replace(/\s+/gu, " ").trim();
    if (text) return text.slice(0, 256);
  }
  return undefined;
}

function escapeHtmlAttr(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;");
}

function serializeBoundedHtml(element: Element, depth: number, budget: { remaining: number }): string {
  if (budget.remaining <= 0) return "";
  const tag = (element.localName || element.tagName || "div").toLowerCase();
  const attrs: string[] = [];
  if (element.attributes) {
    for (let i = 0; i < element.attributes.length && i < 12; i += 1) {
      const attr = element.attributes[i];
      if (!attr || isDisallowedAttrName(attr.name)) continue;
      let val = sanitizeAttrValue(attr.name, attr.value);
      if (tag === "path" && attr.name === "d" && val.length > 48) {
        val = `${val.slice(0, 32)}…`;
      } else if (val.length > 160) {
        val = `${val.slice(0, 157)}…`;
      }
      attrs.push(`${attr.name}="${escapeHtmlAttr(val)}"`);
    }
  }
  const openTag = attrs.length > 0 ? `<${tag} ${attrs.join(" ")}>` : `<${tag}>`;
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
  if (voidTags.has(tag)) {
    budget.remaining -= openTag.length;
    return openTag;
  }

  if (tag === "svg" && depth > 0) {
    const collapsed = `${openTag}…</svg>`;
    budget.remaining -= collapsed.length;
    return collapsed;
  }

  if (depth >= MAX_HTML_DEPTH) {
    const hasContent = element.childNodes.length > 0;
    const collapsed = hasContent ? `${openTag}…</${tag}>` : `${openTag}</${tag}>`;
    budget.remaining -= collapsed.length;
    return collapsed;
  }

  budget.remaining -= openTag.length + tag.length + 3;
  const inner: string[] = [];
  let childElements = 0;
  let truncated = false;

  for (let i = 0; i < element.childNodes.length; i += 1) {
    if (budget.remaining <= 24) {
      truncated = true;
      break;
    }
    const child = element.childNodes[i];
    if (!child) continue;
    if (child.nodeType === 3) {
      const text = (child.nodeValue ?? "").replace(/\s+/gu, " ");
      if (!text.trim()) continue;
      if (isSensitiveDomElement(element)) continue;
      const snippet = text.slice(0, Math.min(200, budget.remaining));
      budget.remaining -= snippet.length;
      inner.push(snippet);
    } else if (child.nodeType === 1) {
      if (childElements >= MAX_HTML_CHILDREN) {
        truncated = true;
        break;
      }
      childElements += 1;
      inner.push(serializeBoundedHtml(child as Element, depth + 1, budget));
    }
  }

  if (truncated) inner.push("…");
  return `${openTag}${inner.join("")}</${tag}>`;
}

function extractTextPreview(element: Element): string | undefined {
  if (isSensitiveDomElement(element)) return undefined;
  const chunks: string[] = [];
  let total = 0;
  const walk = (node: Node, depth: number) => {
    if (total >= MAX_TEXT_CHARS || depth > 12) return;
    if (node.nodeType === 3) {
      const text = (node.nodeValue ?? "").replace(/\s+/gu, " ").trim();
      if (text) {
        chunks.push(text);
        total += text.length + 1;
      }
      return;
    }
    if (node.nodeType === 1) {
      const el = node as Element;
      const tag = (el.localName || el.tagName || "").toLowerCase();
      if (tag === "script" || tag === "style" || tag === "noscript" || isSensitiveDomElement(el)) {
        return;
      }
      for (let i = 0; i < el.childNodes.length; i += 1) {
        walk(el.childNodes[i]!, depth + 1);
        if (total >= MAX_TEXT_CHARS) break;
      }
    }
  };
  walk(element, 0);
  const text = chunks.join(" ").replace(/\s+/gu, " ").trim();
  return text ? text.slice(0, MAX_TEXT_CHARS) : undefined;
}

function extractSafeAttributes(element: Element): Record<string, string> | undefined {
  if (!element.attributes || element.attributes.length === 0) return undefined;
  const result: Record<string, string> = {};
  let count = 0;
  for (let i = 0; i < element.attributes.length && count < MAX_ATTRIBUTES; i += 1) {
    const attr = element.attributes[i];
    if (!attr || !attr.name || attr.name.length > 80 || isDisallowedAttrName(attr.name)) continue;
    result[attr.name] = sanitizeAttrValue(attr.name, attr.value);
    count += 1;
  }
  return count > 0 ? result : undefined;
}

function extractCuratedStyles(element: Element): Record<string, string> | undefined {
  const win = element.ownerDocument?.defaultView ?? (typeof window !== "undefined" ? window : null);
  if (!win || typeof win.getComputedStyle !== "function") return undefined;
  let style: CSSStyleDeclaration;
  try {
    style = win.getComputedStyle(element);
  } catch {
    return undefined;
  }
  const result: Record<string, string> = {};
  let count = 0;
  for (const prop of CURATED_STYLE_PROPS) {
    const val = style.getPropertyValue(prop)?.trim();
    if (!val) continue;
    if (prop === "opacity" && val === "1") continue;
    if (prop === "z-index" && val === "auto") continue;
    if (prop === "gap" && (val === "normal" || val === "0px")) continue;
    if (prop === "border" && (val.startsWith("0px none") || val === "none")) continue;
    if (prop === "border-radius" && val === "0px") continue;
    if (prop === "margin" && val === "0px") continue;
    if (prop === "padding" && val === "0px") continue;
    if (prop === "background-color" && (val === "rgba(0, 0, 0, 0)" || val === "transparent")) continue;
    result[prop] = val.slice(0, 256);
    count += 1;
  }
  return count > 0 ? result : undefined;
}

/**
 * Collects CSS bounding rects of visible password / credential fields in the document
 * (including open shadow roots and same-origin iframes) so Main can pixel-mask them
 * even when DevTools is open and CDP is unavailable.
 */
export function collectSensitiveFieldRects(rootDoc: Document): ViewportRect[] {
  const rects: ViewportRect[] = [];
  const MAX_VISITED = 15_000;
  let visited = 0;

  const visitRoot = (root: Document | ShadowRoot, depth: number) => {
    if (depth > 8 || visited >= MAX_VISITED) return;
    const candidates = root.querySelectorAll?.("input, textarea, select, [autocomplete], iframe, *");
    if (!candidates) return;
    for (let i = 0; i < candidates.length && visited < MAX_VISITED; i += 1) {
      visited += 1;
      const el = candidates[i];
      if (!el) continue;
      if (isSensitiveDomElement(el)) {
        const r = rectInTopViewport(el);
        if (r.width > 0 && r.height > 0) {
          rects.push(r);
        }
      }
      if (el.shadowRoot) {
        visitRoot(el.shadowRoot, depth + 1);
      }
      if ((el.localName || el.tagName || "").toLowerCase() === "iframe") {
        try {
          const frameDoc = (el as HTMLIFrameElement).contentDocument;
          if (frameDoc) visitRoot(frameDoc, depth + 1);
        } catch {
          // Cross-origin iframe; handled separately.
        }
      }
    }
  };

  try {
    visitRoot(rootDoc, 0);
  } catch {
    // Best-effort collection.
  }
  return rects;
}

/** Universal HTML/CSS baseline inspection that always runs for every grabbed element. */
export function inspectDomElement(element: Element): DomInspectionResult {
  const tagName = (element.localName || element.tagName || "div").toLowerCase().slice(0, 64);
  const domLabel = buildDomLabel(element);
  const selector = buildCssSelector(element);
  const role = implicitAriaRole(element);
  const accessibleName = extractAccessibleName(element);
  const htmlSnippet = serializeBoundedHtml(element, 0, { remaining: MAX_HTML_CHARS }).slice(0, MAX_HTML_CHARS);
  const textPreview = extractTextPreview(element);
  const attributes = extractSafeAttributes(element);
  const computedStyles = extractCuratedStyles(element);

  return {
    tagName,
    domLabel,
    selector,
    ...(role ? { role } : {}),
    ...(accessibleName ? { accessibleName } : {}),
    htmlSnippet,
    ...(textPreview ? { textPreview } : {}),
    ...(attributes ? { attributes } : {}),
    ...(computedStyles ? { computedStyles } : {}),
  };
}
