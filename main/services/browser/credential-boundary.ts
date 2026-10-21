// The credential boundary of a Bot's browser (plan §5.1.6): what a snapshot
// may show a model about a page that has password, one-time code or card
// fields on it.
//
// - Text: a sensitive field's accessibility value and everything under it
//   (the text it renders) are dropped, and its element entry keeps only its
//   label and placeholder.
// - Image: main reads every sensitive field's box before and after capture
//   and paints over the area each one covered, before the image leaves
//   main. When a visible frame can't be inspected (a cross-site iframe), the
//   page is zoomed, or the page navigated or scrolled during capture, the
//   image is left out and the snapshot says why.

import type { BrowserElement, BrowserImage, BrowserSnapshot } from "../../../renderer/shared/browser.js";
import {
  isSensitiveField,
  sensitiveFieldBoxes,
  type CdpPort,
  type CssRect,
  type SensitiveFieldBoxes,
} from "./credential-fields.js";
import { cssRectsToImageRects, paintRects, type RawBitmap } from "./credential-mask.js";

/** The page's viewport, measured in Aiden's isolated world (the page can't fake it). */
export interface BoundaryViewport {
  /** CSS pixels, including scrollbars: the area a capture shows. */
  width: number;
  height: number;
  /** Pinch zoom (`visualViewport.scale`). */
  scale: number;
  scrollX: number;
  scrollY: number;
}

export interface CredentialBoundaryPort {
  cdp: CdpPort;
  viewport(): Promise<BoundaryViewport>;
  /** Changes whenever a navigation starts or commits, including a reload. */
  documentRevision(): string;
  capture(): Promise<BrowserImage>;
  decode(image: BrowserImage): RawBitmap;
  encode(bitmap: RawBitmap): BrowserImage;
}

export const BROWSER_IMAGE_OMITTED = Object.freeze({
  frame:
    "The screenshot was left out: part of this page is in a frame Aiden can't check for password, code or card fields. Use the page text instead.",
  zoom: "The screenshot was left out: the page is zoomed in, so password, code or card fields couldn't be covered. Use the page text instead.",
  changed: "The screenshot was left out: the page changed while it was captured. Take another snapshot.",
  unreadable: "The screenshot was left out: Aiden couldn't check this page for password, code or card fields. Use the page text instead.",
});

export const BROWSER_IMAGE_MASKED_NOTE =
  "Password, one-time code and card fields are covered with gray in the screenshot. Never ask the person for what is in them.";

export type MaskedSnapshotImage =
  | { image: BrowserImage; sensitive: ReadonlySet<number>; masked: number }
  | { omitted: string; sensitive: ReadonlySet<number> };

function hull(left: CssRect, right: CssRect): CssRect {
  const x = Math.min(left.x, right.x), y = Math.min(left.y, right.y);
  return {
    x,
    y,
    width: Math.max(left.x + left.width, right.x + right.width) - x,
    height: Math.max(left.y + left.height, right.y + right.height) - y,
  };
}

/**
 * Every area a sensitive field covered in either read. A field seen in both
 * gets the hull of its two boxes, so one that moved during capture is covered
 * along the way.
 */
export function sensitiveAreas(before: SensitiveFieldBoxes, after: SensitiveFieldBoxes): CssRect[] {
  const areas = new Map<number, CssRect>();
  for (const { backendNodeId, box } of [...before.fields, ...after.fields]) {
    const seen = areas.get(backendNodeId);
    areas.set(backendNodeId, seen ? hull(seen, box) : box);
  }
  return [...areas.values()];
}

function sameViewport(left: BoundaryViewport, right: BoundaryViewport): boolean {
  return left.width === right.width && left.height === right.height && left.scale === right.scale
    && left.scrollX === right.scrollX && left.scrollY === right.scrollY;
}

/**
 * Capture the page and paint over its sensitive fields, or say why the image
 * is left out. Never returns an unmasked capture of a page with a field it
 * couldn't place.
 */
export async function maskBrowserSnapshotImage(port: CredentialBoundaryPort): Promise<MaskedSnapshotImage> {
  const revision = port.documentRevision();
  let viewport: BoundaryViewport;
  let before: SensitiveFieldBoxes;
  try {
    viewport = await port.viewport();
    before = await sensitiveFieldBoxes(port.cdp, viewport);
  } catch {
    return { omitted: BROWSER_IMAGE_OMITTED.unreadable, sensitive: new Set() };
  }
  if (before.opaqueFrames > 0) return { omitted: BROWSER_IMAGE_OMITTED.frame, sensitive: new Set(before.sensitive) };
  if (viewport.scale !== 1) return { omitted: BROWSER_IMAGE_OMITTED.zoom, sensitive: new Set(before.sensitive) };
  const image = await port.capture();
  let after: SensitiveFieldBoxes;
  let afterViewport: BoundaryViewport;
  try {
    after = await sensitiveFieldBoxes(port.cdp, viewport);
    afterViewport = await port.viewport();
  } catch {
    return { omitted: BROWSER_IMAGE_OMITTED.unreadable, sensitive: new Set(before.sensitive) };
  }
  const sensitive = new Set([...before.sensitive, ...after.sensitive]);
  if (after.opaqueFrames > 0) return { omitted: BROWSER_IMAGE_OMITTED.frame, sensitive };
  if (port.documentRevision() !== revision || !sameViewport(viewport, afterViewport)) {
    return { omitted: BROWSER_IMAGE_OMITTED.changed, sensitive };
  }
  const areas = sensitiveAreas(before, after);
  if (areas.length === 0) return { image, sensitive, masked: 0 };
  let bitmap: RawBitmap;
  try {
    bitmap = port.decode(image);
    paintRects(bitmap, cssRectsToImageRects(areas, viewport, bitmap));
  } catch {
    return { omitted: BROWSER_IMAGE_OMITTED.unreadable, sensitive };
  }
  return { image: port.encode(bitmap), sensitive, masked: areas.length };
}

interface AxNode {
  nodeId?: unknown;
  backendDOMNodeId?: unknown;
  childIds?: unknown;
  value?: unknown;
  properties?: unknown;
  [key: string]: unknown;
}

function scrubAccessibility(tree: unknown, sensitive: ReadonlySet<number>): unknown {
  const nodes = (tree as { nodes?: unknown } | undefined)?.nodes;
  if (!Array.isArray(nodes) || sensitive.size === 0) return tree;
  const byId = new Map<string, AxNode>();
  for (const node of nodes as AxNode[]) if (node && typeof node.nodeId === "string") byId.set(node.nodeId, node);
  // Everything a sensitive field renders (its text and inline boxes) goes.
  const dropped = new Set<string>();
  const queue: string[] = [];
  for (const node of nodes as AxNode[]) {
    if (node && typeof node.backendDOMNodeId === "number" && sensitive.has(node.backendDOMNodeId) && Array.isArray(node.childIds)) {
      queue.push(...node.childIds.filter((id): id is string => typeof id === "string"));
    }
  }
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (dropped.has(id)) continue;
    dropped.add(id);
    const child = byId.get(id);
    if (child && Array.isArray(child.childIds)) queue.push(...child.childIds.filter((next): next is string => typeof next === "string"));
  }
  return {
    ...(tree as object),
    nodes: (nodes as AxNode[]).flatMap((node) => {
      if (!node || typeof node !== "object") return [node];
      if (typeof node.nodeId === "string" && dropped.has(node.nodeId)) return [];
      if (typeof node.backendDOMNodeId !== "number" || !sensitive.has(node.backendDOMNodeId)) return [node];
      const { value: _value, childIds: _children, ...rest } = node;
      const properties = Array.isArray(node.properties)
        ? node.properties.filter((property) => (property as { name?: unknown })?.name !== "valuetext")
        : node.properties;
      return [{ ...rest, ...(properties === undefined ? {} : { properties }) }];
    }),
  };
}

function elementIsSensitive(element: BrowserElement): boolean {
  const attributes = element.attributes ?? {};
  return isSensitiveField({
    localName: element.tag,
    attributes: Object.entries(attributes).flatMap(([name, value]) => [name, value]),
  });
}

function scrubElement(element: BrowserElement): BrowserElement {
  if (!elementIsSensitive(element)) return element;
  const attributes = element.attributes ?? {};
  // `text` may be what the field shows (a contenteditable field's innerText).
  return { ...element, text: (attributes["aria-label"] ?? attributes.placeholder ?? "").slice(0, 500) };
}

/**
 * Drop sensitive field values from a snapshot's text parts. `sensitive` holds
 * the backend node ids main found in the page's DOM.
 */
export function scrubBrowserSnapshot(snapshot: BrowserSnapshot, sensitive: ReadonlySet<number>): BrowserSnapshot {
  return {
    ...snapshot,
    elements: snapshot.elements.map(scrubElement),
    ...(snapshot.accessibilityTree === undefined
      ? {}
      : { accessibilityTree: scrubAccessibility(snapshot.accessibilityTree, sensitive) }),
  };
}

/** The agent's answer on a tab the person holds (a sign-in or hand-off card, or a takeover), snapshots included. */
export const BROWSER_HELD_TAB_REFUSED = "The person is using this tab. Wait for them to finish.";
export const BROWSER_SENSITIVE_TYPING_REFUSED =
  "A Bot can't type into a password, one-time code or card field. Hand this step to the person.";
export const BROWSER_OPAQUE_TYPING_REFUSED =
  "A Bot can't type into a field inside this frame, because Aiden can't check what kind of field it is. Hand this step to the person.";
export const BROWSER_VALUE_SELECTOR_REFUSED =
  "A Bot can't find fields by what is typed in them. Use a role, label or text locator.";

/**
 * In-page helpers, run in Aiden's isolated world: the same field rule as
 * `isSensitiveField`, and the element that really has focus (through shadow
 * roots and same-origin frames). A focused frame Aiden can't enter is opaque.
 */
export const BROWSER_SENSITIVE_FIELD_SOURCE = `const __aidenSensitive=(e)=>{if(!e||e.nodeType!==1)return false;const n=String(e.localName||"").toLowerCase();if(n==="input"&&String(e.getAttribute("type")||"").trim().toLowerCase()==="password")return true;const scope=new Set(["shipping","billing","home","work","mobile","fax","pager","webauthn"]);return String(e.getAttribute("autocomplete")||"").toLowerCase().split(/\\s+/).filter(t=>t&&!t.startsWith("section-")&&!scope.has(t)).some(t=>t==="current-password"||t==="new-password"||t==="one-time-code"||t.startsWith("cc-"));};const __aidenFocused=()=>{let e=document.activeElement;for(let i=0;i<32&&e;i+=1){if(e.shadowRoot&&e.shadowRoot.activeElement){e=e.shadowRoot.activeElement;continue;}const n=String(e.localName||"").toLowerCase();if(n==="iframe"||n==="frame"||n==="object"||n==="embed"||n==="fencedframe"){let d=null;try{d=e.contentDocument;}catch{d=null;}if(!d)return{element:e,opaque:true};const inner=d.activeElement;if(!inner||inner===d.body||inner===d.documentElement)return{element:e,opaque:false};e=inner;continue;}break;}return{element:e,opaque:false};};`;

/** A guard (for an isolated-world script) that refuses typing into `element` or whatever has focus. */
export function browserTypingGuardSource(element: string): string {
  return `{const __target=${element};const __focus=__aidenFocused();if(__aidenSensitive(__target)||__aidenSensitive(__focus.element))throw new Error(${JSON.stringify(BROWSER_SENSITIVE_TYPING_REFUSED)});if(__focus.opaque)throw new Error(${JSON.stringify(BROWSER_OPAQUE_TYPING_REFUSED)});}`;
}

/**
 * A guard's refusal thrown inside the page reaches main as the page's error
 * text, stack included. This gives the Bot the sentence alone; any other
 * error passes through unchanged.
 */
export function boundaryRefusalOf(error: unknown): unknown {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  for (const sentence of [BROWSER_SENSITIVE_TYPING_REFUSED, BROWSER_OPAQUE_TYPING_REFUSED]) {
    if (message.includes(sentence)) return new Error(sentence);
  }
  return error;
}

/** Attribute tests on `value` (or escapes that could spell one) would let a selector read a field. */
const VALUE_PROBE = /\[\s*(?:[\w*-]*\|)?value\b|@value\b|\\/iu;

export function assertBoundarySelector(selector: string | undefined): void {
  if (selector !== undefined && VALUE_PROBE.test(selector)) throw new Error(BROWSER_VALUE_SELECTOR_REFUSED);
}

/**
 * Whether a `browser_press` key would put text into the focused field: one
 * character with no modifier, or a paste chord.
 */
export function browserKeyInsertsText(key: string, modifiers: readonly string[] = []): boolean {
  const parts = key.split("+");
  const last = parts.pop() ?? "";
  const names = new Set([...parts, ...modifiers].map((name) => name.toLowerCase()));
  if (names.size === 0) return [...last].length === 1;
  const paste = (names.has("control") || names.has("ctrl") || names.has("meta") || names.has("command")) && last.toLowerCase() === "v";
  return paste || (names.has("shift") && last === "Insert");
}
