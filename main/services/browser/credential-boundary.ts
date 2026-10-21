// The credential boundary of a Bot's browser (plan §5.1.6): what a snapshot
// may show a model about a page that has password, one-time code or card
// fields on it.
//
// - Text: a sensitive field's accessibility value and everything under it
//   (the text it renders) are dropped, and its element entry keeps only its
//   label and placeholder. Any other node whose accessible name, description
//   or value could include what a field holds (a table cell, a checkbox whose
//   label wraps a card field) loses it, and element locators are generated in
//   a Bot's view of the page (`browserBoundarySelectorsExpression`).
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
  type SensitiveFieldReach,
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
  /** Fields the tab has seen as sensitive (`SensitiveFieldMemory`): covered whatever they are now. */
  remembered?: ReadonlySet<number>;
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
    before = await sensitiveFieldBoxes(port.cdp, viewport, port.remembered);
  } catch {
    return { omitted: BROWSER_IMAGE_OMITTED.unreadable, sensitive: new Set() };
  }
  if (before.opaqueFrames > 0) return { omitted: BROWSER_IMAGE_OMITTED.frame, sensitive: new Set(before.sensitive) };
  if (viewport.scale !== 1) return { omitted: BROWSER_IMAGE_OMITTED.zoom, sensitive: new Set(before.sensitive) };
  const image = await port.capture();
  let after: SensitiveFieldBoxes;
  let afterViewport: BoundaryViewport;
  try {
    after = await sensitiveFieldBoxes(port.cdp, viewport, port.remembered);
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
  name?: unknown;
  description?: unknown;
  value?: unknown;
  properties?: unknown;
  [key: string]: unknown;
}

interface AxValue {
  type?: unknown;
  value?: unknown;
  sources?: unknown;
  relatedNodes?: unknown;
  [key: string]: unknown;
}

interface AxSource {
  type?: unknown;
  attribute?: unknown;
  value?: AxValue;
  attributeValue?: AxValue;
  nativeSourceValue?: AxValue;
  superseded?: unknown;
}

function related(source: AxSource): Array<{ backendDOMNodeId?: unknown }> {
  return [source.value, source.attributeValue, source.nativeSourceValue].flatMap((value) =>
    Array.isArray(value?.relatedNodes) ? (value.relatedNodes as Array<{ backendDOMNodeId?: unknown }>) : [],
  );
}

/** A copy of `value` without the `text` of any related node that reaches a sensitive field (Chromium's text for it). */
function withoutRelatedText(value: unknown, reachesField: (id: unknown) => boolean): unknown {
  if (Array.isArray(value)) return value.map((item) => withoutRelatedText(item, reachesField));
  if (!value || typeof value !== "object") return value;
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    copy[key] = key === "relatedNodes" && Array.isArray(item)
      ? item.map((node) => {
          if (!node || typeof node !== "object" || !("text" in node) || !reachesField((node as { backendDOMNodeId?: unknown }).backendDOMNodeId)) return node;
          const { text: _text, ...rest } = node as Record<string, unknown>;
          return rest;
        })
      : withoutRelatedText(item, reachesField);
  }
  return copy;
}

/**
 * An accessible name Chromium computed from what a field holds is blanked.
 * Chromium reports which source gave the name: an attribute (`aria-label`,
 * `title`) or a placeholder is the page's own text and stays; a name from
 * `aria-labelledby` or a `<label>` is blanked when the labelling element
 * reaches a field other than the node itself (a field's own label keeps
 * naming it); any other name (its content) is blanked when the node reaches a
 * field other than itself. The other sources Chromium lists, superseded ones
 * included, are dropped from a node that reaches a field.
 */
function scrubAxName(name: AxValue, id: number, reach: SensitiveFieldReach, readsAny: (id: unknown) => boolean): AxValue {
  const readsOther = (node: unknown): boolean =>
    typeof node !== "number" || !reach.known.has(node) || [...(reach.reads.get(node) ?? [])].some((field) => field !== id);
  const sources = (Array.isArray(name.sources) ? name.sources : []) as AxSource[];
  const involved = readsAny(id) || sources.some((source) => related(source).some((node) => readsAny(node.backendDOMNodeId)));
  if (!involved) return name;
  const used = sources.find((source) => source && source.value !== undefined && source.superseded !== true);
  const links = used ? related(used) : [];
  const fixed = used !== undefined && links.length === 0
    && ((used.type === "attribute" && used.attribute !== "aria-labelledby") || used.type === "placeholder");
  const blank = fixed
    ? false
    : used?.type === "relatedElement" && links.length > 0
      ? links.some((node) => readsOther(node.backendDOMNodeId))
      : readsOther(id) || reach.selfNamed.has(id);
  if (blank) return { type: name.type, value: "" };
  return Array.isArray(name.sources) ? { ...name, sources: used ? [used] : [] } : name;
}

/**
 * Drop what sensitive fields hold from the accessibility tree: each field's
 * value and everything it renders, and, with `reach`, every node inside a
 * field or not seen by the DOM read, accessible names and descriptions that
 * include a field's content (`scrubAxName`), the value of an element holding
 * another field, and Chromium's text for any related node that reaches one.
 */
function scrubAccessibility(tree: unknown, reach: SensitiveFieldReach): unknown {
  const { sensitive } = reach;
  const nodes = (tree as { nodes?: unknown } | undefined)?.nodes;
  if (!Array.isArray(nodes) || sensitive.size === 0) return tree;
  const byId = new Map<string, AxNode>();
  for (const node of nodes as AxNode[]) if (node && typeof node.nodeId === "string") byId.set(node.nodeId, node);
  const childIds = (node: AxNode | undefined): string[] =>
    node && Array.isArray(node.childIds) ? node.childIds.filter((id): id is string => typeof id === "string") : [];
  // Everything a sensitive field renders (its text and inline boxes) goes, as
  // does any node inside one (moved out by `aria-owns`) or unseen by the DOM read.
  const dropped = new Set<string>();
  const queue: string[] = [];
  for (const node of nodes as AxNode[]) {
    if (!node || typeof node.backendDOMNodeId !== "number") continue;
    const id = node.backendDOMNodeId;
    if (sensitive.has(id)) queue.push(...childIds(node));
    else if ((reach.inside.has(id) || !reach.known.has(id)) && typeof node.nodeId === "string") queue.push(node.nodeId);
  }
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (dropped.has(id)) continue;
    dropped.add(id);
    queue.push(...childIds(byId.get(id)));
  }
  const readsAny = (id: unknown): boolean => typeof id !== "number" || !reach.known.has(id) || (reach.reads.get(id)?.size ?? 0) > 0;
  return {
    ...(tree as object),
    nodes: (nodes as AxNode[]).flatMap((node) => {
      if (!node || typeof node !== "object") return [node];
      if (typeof node.nodeId === "string" && dropped.has(node.nodeId)) return [];
      if (typeof node.backendDOMNodeId !== "number") return [node];
      const id = node.backendDOMNodeId;
      let next: AxNode = node;
      if (sensitive.has(id) || [...(reach.holds.get(id) ?? [])].some((field) => field !== id)) {
        const { value: _value, ...rest } = next;
        const properties = Array.isArray(next.properties)
          ? next.properties.filter((property) => (property as { name?: unknown })?.name !== "valuetext")
          : next.properties;
        next = { ...rest, ...(properties === undefined ? {} : { properties }) };
      }
      if (sensitive.has(id)) {
        const { childIds: _children, ...rest } = next;
        next = rest;
      }
      if (next.name && typeof next.name === "object") next = { ...next, name: scrubAxName(next.name as AxValue, id, reach, readsAny) };
      const description = next.description as AxValue | undefined;
      if (description && typeof description === "object" && description.value && (reach.describedBy.get(id) ?? []).some(readsAny)) {
        next = { ...next, description: { type: description.type, value: "" } };
      }
      return [withoutRelatedText(next, readsAny) as AxNode];
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

/** Playwright engines that name an element by the text inside it (`internal:text="…"`, `:has-text(…)`). */
const TEXT_ENGINE = /(?:^|>>|\s)\s*(?:internal:)?(?:has-)?text\s*=|:(?:has-)?text(?:-is|-matches)?\s*\(/iu;

/** A locator for a field from its tag and the attributes a snapshot shows, never from its contents. */
function structuralSelector(element: BrowserElement): string {
  const attributes = element.attributes ?? {};
  const tag = /^[a-z][a-z\d-]*$/u.test(element.tag) ? element.tag : "*";
  const named = ["type", "autocomplete", "name"].flatMap((name) =>
    attributes[name] === undefined ? [] : [`[${name}=${JSON.stringify(attributes[name])}]`],
  );
  return `${tag}${named.join("")}`;
}

function scrubElement(element: BrowserElement): BrowserElement {
  if (!elementIsSensitive(element)) return element;
  const attributes = element.attributes ?? {};
  return {
    ...element,
    // `text` may be what the field shows (a contenteditable field's innerText).
    text: (attributes["aria-label"] ?? attributes.placeholder ?? "").slice(0, 500),
    // Playwright names a field with text inside it (a textarea) by that text.
    ...(TEXT_ENGINE.test(element.selector) ? { selector: structuralSelector(element) } : {}),
  };
}

/**
 * Drop sensitive field values from a snapshot's text parts. `reach` holds the
 * fields main found in the page's DOM and what reaches them, read after the
 * accessibility tree.
 */
export function scrubBrowserSnapshot(snapshot: BrowserSnapshot, reach: SensitiveFieldReach): BrowserSnapshot {
  return {
    ...snapshot,
    elements: snapshot.elements.map(scrubElement),
    ...(snapshot.accessibilityTree === undefined
      ? {}
      : { accessibilityTree: scrubAccessibility(snapshot.accessibilityTree, reach) }),
  };
}

/** A Bot's browser never runs these: page scripts, recording, local files, annotation, screenshot capture, DevTools. */
export const BROWSER_BOUNDARY_ACTION_REFUSED = "A Bot's browser can't run page scripts, record, or open local files.";
/** The agent's answer on a tab the person holds (a sign-in or hand-off card, or a takeover), snapshots included. */
export const BROWSER_HELD_TAB_REFUSED = "The person is using this tab. Wait for them to finish.";
export const BROWSER_SENSITIVE_TYPING_REFUSED =
  "A Bot can't type into a password, one-time code or card field. Hand this step to the person.";
export const BROWSER_OPAQUE_TYPING_REFUSED =
  "A Bot can't type into a field inside this frame, because Aiden can't check what kind of field it is. Hand this step to the person.";
export const BROWSER_VALUE_SELECTOR_REFUSED =
  "A Bot can't find fields by what is typed in them. Use a role, label or text locator.";
export const BROWSER_XPATH_SELECTOR_REFUSED =
  "A Bot can't use XPath locators. Use a role, label, text or CSS locator.";
/** Only if the bundled Playwright runtime no longer has the text cache a Bot's locator relies on. */
export const BROWSER_LOCATOR_UNCHECKED_REFUSED =
  "Aiden couldn't check this locator against password, code or card fields. Use the page snapshot's element references.";

/**
 * In-page helpers, run in Aiden's isolated world: the same field rule as
 * `isSensitiveField` (`__aidenSensitiveNow`), which a field main recalled as
 * sensitive (`BROWSER_RECALL_FIELD_FUNCTION`) also meets, and the element
 * that really has focus (through shadow roots and same-origin frames). A
 * focused frame Aiden can't enter is opaque.
 */
export const BROWSER_SENSITIVE_FIELD_SOURCE = `const __aidenSensitiveNow=(e)=>{if(!e||e.nodeType!==1)return false;const n=String(e.localName||"").toLowerCase();if(n==="input"&&String(e.getAttribute("type")||"").trim().toLowerCase()==="password")return true;const scope=new Set(["shipping","billing","home","work","mobile","fax","pager","webauthn"]);return String(e.getAttribute("autocomplete")||"").toLowerCase().split(/\\s+/).filter(t=>t&&!t.startsWith("section-")&&!scope.has(t)).some(t=>t==="current-password"||t==="new-password"||t==="one-time-code"||t.startsWith("cc-"));};const __aidenSensitive=(e)=>__aidenSensitiveNow(e)||Boolean(e&&globalThis.__aidenRecalledFields?.has(e));const __aidenFocused=()=>{let e=document.activeElement;for(let i=0;i<32&&e;i+=1){if(e.shadowRoot&&e.shadowRoot.activeElement){e=e.shadowRoot.activeElement;continue;}const n=String(e.localName||"").toLowerCase();if(n==="iframe"||n==="frame"||n==="object"||n==="embed"||n==="fencedframe"){let d=null;try{d=e.contentDocument;}catch{d=null;}if(!d)return{element:e,opaque:true};const inner=d.activeElement;if(!inner||inner===d.body||inner===d.documentElement)return{element:e,opaque:false};e=inner;continue;}break;}return{element:e,opaque:false};};`;

/**
 * Called on a field (`Runtime.callFunctionOn`, in Aiden's isolated world)
 * that main remembers as sensitive though it no longer looks it, so the
 * in-page helpers treat it as sensitive too.
 */
export const BROWSER_RECALL_FIELD_FUNCTION = "function(){(globalThis.__aidenRecalledFields??=new WeakSet()).add(this);}";

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
  for (const sentence of [
    BROWSER_SENSITIVE_TYPING_REFUSED,
    BROWSER_OPAQUE_TYPING_REFUSED,
    BROWSER_XPATH_SELECTOR_REFUSED,
    BROWSER_LOCATOR_UNCHECKED_REFUSED,
  ]) {
    if (message.includes(sentence)) return new Error(sentence);
  }
  return error;
}

/**
 * Attribute tests on `value` would let a selector read a field: a CSS or
 * Playwright attribute selector, or an escape that could spell one.
 */
const VALUE_ATTRIBUTE = /\[\s*(?:[\w*-]*\|)?value\b|\\/iu;
/**
 * Where Playwright's parser reads XPath: an `xpath=` engine, or a part that
 * starts with `//` or `..`, at the start, after `>>`, or opening the quoted
 * body of a nested selector (`internal:has="…"`, `left-of="…"`…). A quick
 * check in main; the page check is exact.
 */
const XPATH_SELECTOR = /(?:^|>>|\*?\s*(?:internal:(?:has|has-not|and|or|chain)|left-of|right-of|above|below|near)\s*=\s*")\s*\*?\s*(?:xpath(?::light)?\s*=|\(*\/\/|\.\.)/iu;
/** CSS comments, which a selector parser skips, so a comment can hide `[value`. */
const CSS_COMMENT = /\/\*[\s\S]*?(?:\*\/|$)/gu;

/**
 * Refuse a selector that could tell what a field holds before the page runs
 * it: one testing a `value` attribute, directly or behind a CSS comment, and
 * any XPath, whose string tests read the text inside a field and every
 * element around it. `browserBoundaryLocatorExpression` refuses XPath again
 * with Playwright's own parser.
 */
export function assertBoundarySelector(selector: string | undefined): void {
  if (selector === undefined) return;
  const uncommented = selector.replace(CSS_COMMENT, "");
  if (VALUE_ATTRIBUTE.test(selector) || VALUE_ATTRIBUTE.test(uncommented)) throw new Error(BROWSER_VALUE_SELECTOR_REFUSED);
  if (XPATH_SELECTOR.test(selector) || XPATH_SELECTOR.test(uncommented)) throw new Error(BROWSER_XPATH_SELECTOR_REFUSED);
}

/**
 * Whether an element's accessible name (or description) could include what
 * a field holds, in Aiden's isolated world after
 * `BROWSER_SENSITIVE_FIELD_SOURCE`: `__aidenNameReadsField(e, body)` for a
 * role selector's body (it tests a name when the body mentions one), and
 * `__aidenBoundaryName(e)`, Playwright's name for `e` or "" when it could.
 * See `BROWSER_BOUNDARY_SCOPE_SOURCE` for the rules.
 */
export const BROWSER_BOUNDARY_NAME_SOURCE = `const __aidenNameReadsField=(()=>{
const parent=(e)=>e.parentElement||(e.parentNode&&e.parentNode.host)||null;
const inside=(e)=>{for(let a=parent(e);a;a=parent(a))if(__aidenSensitive(a))return true;return false;};
const children=(e)=>[...e.children,...(e.shadowRoot?e.shadowRoot.children:[]),...(e.localName==="slot"&&typeof e.assignedElements==="function"?e.assignedElements({flatten:true}):[])];
const refs=(e,name)=>{const value=e.getAttribute(name);const root=e.getRootNode();const found=[];if(!value||!root||typeof root.querySelector!=="function")return found;for(const id of new Set([...value.split(" "),...value.split(/\\s+/)])){if(!id)continue;const target=root.querySelector("#"+CSS.escape(id));if(target)found.push(target);}return found;};
const reaches=(c,from,self)=>{const seen=new Set(self?[]:[c]);const queue=[...from];let budget=20000;while(queue.length>0){const e=queue.pop();if(seen.has(e))continue;seen.add(e);if(--budget<0||__aidenSensitive(e))return true;queue.push(...children(e),...refs(e,"aria-owns"),...refs(e,"aria-labelledby"),...(e.labels||[]));}return false;};
return (c,body)=>{
if(inside(c))return true;
const named=/name|\\\\/i.test(body),described=/description|\\\\/i.test(body);
if(!named&&!described)return false;
if(__aidenSensitive(c)&&!["input","textarea","select"].includes(String(c.localName).toLowerCase()))return true;
if(described&&reaches(c,refs(c,"aria-describedby"),true))return true;
if(!named)return false;
const label=c.getAttribute("aria-label");
if(!c.hasAttribute("aria-labelledby")&&label&&label.trim())return false;
return reaches(c,refs(c,"aria-labelledby"),true)||reaches(c,[...children(c),...refs(c,"aria-owns"),...(c.labels||[])],false);};
})();
const __aidenBoundaryName=(e)=>__aidenNameReadsField(e,"name")?"":String(globalThis.__aidenPlaywright.utils.getElementAccessibleNameText(e,false)||"");`;

/**
 * A Bot's view of the page for Playwright's selector engines, in Aiden's
 * isolated world after `BROWSER_SENSITIVE_FIELD_SOURCE` and
 * `BROWSER_BOUNDARY_NAME_SOURCE`: `__aidenBoundaryScope(run)` calls `run`
 * with it in place and puts Playwright back after.
 *
 * - Text and label engines (`text=`, `internal:text`, `:has-text()`,
 *   `internal:label`...) read element text through the evaluator's text
 *   cache. It is cleared, then filled with no text for each sensitive field
 *   and everything inside it.
 * - Role engines (`role=`, `internal:role`) compute accessible names and
 *   descriptions themselves, and read a field's live value (a password's
 *   too) into the name of a cell, row, checkbox label or button around it.
 *   Their matches leave out any element whose name or description, when the
 *   role tests one, could read a field: through its content (children,
 *   shadow tree, slotted elements), `aria-owns`, `<label>` elements or
 *   `aria-labelledby` (`aria-describedby` for a description), followed from
 *   element to element. A field's own label doesn't count, unless it is an
 *   element it names by `aria-labelledby`, whose content Playwright reads
 *   with the field's value in it. An element named by its own `aria-label`
 *   alone keeps its name, as does a field named only by its label. Elements
 *   inside a field (a card-expiry list's options) never match, and a field
 *   that isn't an input, textarea or select (a contenteditable code field)
 *   never matches by name.
 *
 * So a field's contents never decide a match, for the field or any element
 * around it. Without the cache or the engines (another Playwright runtime),
 * nothing runs.
 */
const BROWSER_BOUNDARY_SCOPE_SOURCE = `const __aidenBoundaryScope=(run)=>{
const p=globalThis.__aidenPlaywright;const evaluator=p&&p._evaluator;const cache=evaluator&&evaluator._cacheText;const engines=p&&p._engines;
const roles=engines instanceof Map?["role","internal:role"].map((name)=>[name,engines.get(name)]):[];
if(!(cache instanceof Map)||typeof evaluator.begin!=="function"||typeof evaluator.end!=="function"||roles.length===0||roles.some(([,engine])=>!engine||typeof engine.queryAll!=="function"))throw new Error(${JSON.stringify(BROWSER_LOCATOR_UNCHECKED_REFUSED)});
evaluator.begin();
try{
for(const key of Object.keys(evaluator)){const value=evaluator[key];if(key.startsWith("_cache")&&value instanceof Map)value.clear();}
const blank=(node)=>cache.set(node,{full:"",normalized:"",immediate:[]});
const blankAll=(root)=>{for(const e of root.querySelectorAll("*")){blank(e);if(e.shadowRoot){blank(e.shadowRoot);blankAll(e.shadowRoot);}}};
const hide=(root)=>{for(const e of root.querySelectorAll("*")){if(__aidenSensitive(e)){blank(e);blankAll(e);if(e.shadowRoot){blank(e.shadowRoot);blankAll(e.shadowRoot);}}else if(e.shadowRoot)hide(e.shadowRoot);}};
hide(document);
for(const [name,engine] of roles)engines.set(name,{queryAll:(root,body)=>engine.queryAll(root,body).filter((e)=>!__aidenNameReadsField(e,String(body)))});
return run();
}finally{for(const [name,engine] of roles)engines.set(name,engine);evaluator.end();}};`;

/**
 * Resolves a Bot's locator, after `BROWSER_BOUNDARY_SCOPE_SOURCE`.
 * Playwright's parser finds any XPath part, nested ones included, and the
 * selector is refused. More than one match is refused without Playwright's
 * previews, which quote attributes and text.
 */
const BROWSER_BOUNDARY_QUERY_SOURCE = `const __aidenBoundaryQuery=(selector)=>{
const p=globalThis.__aidenPlaywright;const parsed=p.parseSelector(selector);
const xpath=(s)=>s.parts.some((part)=>part.name==="xpath"||part.name.startsWith("xpath:")||Boolean(part.body&&typeof part.body==="object"&&part.body.parsed&&xpath(part.body.parsed)));
if(xpath(parsed))throw new Error(${JSON.stringify(BROWSER_XPATH_SELECTOR_REFUSED)});
return __aidenBoundaryScope(()=>{
const found=p.querySelectorAll(parsed,document);
if(found.length>1){const error=new Error("strict mode violation: this locator matches "+found.length+" elements. Use one that matches exactly one.");delete error.stack;throw error;}
return found[0];});};`;

/** An isolated-world expression for the one element a Bot's locator names (see `BROWSER_BOUNDARY_SCOPE_SOURCE`). */
export function browserBoundaryLocatorExpression(selector: string): string {
  return `(()=>{${BROWSER_SENSITIVE_FIELD_SOURCE}${BROWSER_BOUNDARY_NAME_SOURCE}${BROWSER_BOUNDARY_SCOPE_SOURCE}${BROWSER_BOUNDARY_QUERY_SOURCE}return __aidenBoundaryQuery(${JSON.stringify(selector)});})()`;
}

/**
 * An isolated-world expression for the selectors a Bot's snapshot gives the
 * elements in `elements` (an expression for an array of them). Playwright's
 * generator checks each candidate by running it, so in a Bot's view (see
 * `BROWSER_BOUNDARY_SCOPE_SOURCE`) it never picks one whose match depends on
 * what a field holds, such as the name of a button around a card textarea,
 * and every selector it gives still finds its element for the Bot. Without
 * that view it falls back to CSS selectors.
 */
export function browserBoundarySelectorsExpression(elements: string): string {
  return `(()=>{${BROWSER_SENSITIVE_FIELD_SOURCE}${BROWSER_BOUNDARY_NAME_SOURCE}${BROWSER_BOUNDARY_SCOPE_SOURCE}const p=globalThis.__aidenPlaywright;const list=[...${elements}];try{return __aidenBoundaryScope(()=>list.map((e)=>p.generateSelectorSimple(e,{})));}catch{return list.map((e)=>p.generateSelectorSimple(e,{noText:true,omitInternalEngines:true}));}})()`;
}

/**
 * What a Bot hears when another element covers its target. Playwright's own
 * message previews the covering element's attributes and text, which for a
 * card field laid over a label is the card number.
 */
export const BROWSER_COVERED_TARGET = "Another element covers the target.";
export const BROWSER_COVERED_OR_MOVED_TARGET = "Another element covers the target or it moved.";

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
