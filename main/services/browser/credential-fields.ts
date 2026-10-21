// Which parts of a page hold a secret, read from the DevTools DOM tree in main.
//
// A "sensitive field" is a password input, or any element whose `autocomplete`
// names a credential, a one-time code or a payment card (plan §5.1.6). The
// walker reads `DOM.getDocument({ depth: -1, pierce: true })`, which reaches
// every shadow root and every frame rendered in the page's own process. A
// frame in another process (a cross-site iframe under site isolation) has no
// readable document there; it is reported as opaque, because a field inside
// it could not be found, so its pixels can't be masked.

/** One node of a `DOM.getDocument` result: only the fields the walker reads. */
export interface CdpDomNode {
  backendNodeId: number;
  nodeType: number;
  nodeName: string;
  localName?: string;
  /** Flat `[name, value, name, value, …]`. */
  attributes?: string[];
  children?: CdpDomNode[];
  shadowRoots?: CdpDomNode[];
  contentDocument?: CdpDomNode;
  /** Set on frame owner elements (`iframe`, `frame`). */
  frameId?: string;
}

/** The DevTools protocol, as main reaches it through `webContents.debugger`. */
export interface CdpPort {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface CssRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CredentialTreeScan {
  /** Backend node ids of sensitive fields, in document order. */
  sensitive: number[];
  /** Backend node ids of frame and plugin elements whose document can't be read here. */
  opaqueFrames: number[];
}

export interface SensitiveFieldBoxes {
  /** Every rendered sensitive field and its box, in CSS pixels of the top-level viewport. */
  fields: Array<{ backendNodeId: number; box: CssRect }>;
  /** Backend node ids of every sensitive field found, rendered or not. */
  sensitive: number[];
  /** Visible frames whose content can't be inspected: any field inside them is unmaskable. */
  opaqueFrames: number;
}

const ELEMENT_NODE = 1;
/** Elements that host another document or a plugin. */
const FRAME_ELEMENTS: ReadonlySet<string> = new Set(["iframe", "frame", "fencedframe", "object", "embed", "portal"]);
const CREDENTIAL_TOKENS: ReadonlySet<string> = new Set(["current-password", "new-password", "one-time-code"]);
/** Autocomplete tokens that only scope the field token after them (WHATWG autofill detail tokens). */
const SCOPE_TOKENS: ReadonlySet<string> = new Set(["shipping", "billing", "home", "work", "mobile", "fax", "pager", "webauthn"]);
/** A pathological DOM is still walked, but not without bound. */
const MAX_NODES = 200_000;

function attribute(node: Pick<CdpDomNode, "attributes">, name: string): string | undefined {
  const attributes = node.attributes ?? [];
  for (let index = 0; index + 1 < attributes.length; index += 2) {
    if (attributes[index]!.toLowerCase() === name) return attributes[index + 1];
  }
  return undefined;
}

/** The field tokens of an `autocomplete` value, without section and address-group scopes. */
export function autocompleteFieldTokens(value: string | undefined): string[] {
  return (value ?? "")
    .toLowerCase()
    .split(/[\s]+/u)
    .filter((token) => token.length > 0 && !token.startsWith("section-") && !SCOPE_TOKENS.has(token));
}

/** Whether an element holds a password, a one-time code or card details. */
export function isSensitiveField(element: { localName?: string; nodeName?: string; attributes?: string[] }): boolean {
  const name = (element.localName ?? element.nodeName ?? "").toLowerCase();
  if (name === "input" && (attribute(element, "type") ?? "").trim().toLowerCase() === "password") return true;
  return autocompleteFieldTokens(attribute(element, "autocomplete")).some(
    (token) => CREDENTIAL_TOKENS.has(token) || token.startsWith("cc-"),
  );
}

/** Sensitive fields and unreadable frames in a pierced `DOM.getDocument` tree. */
export function scanCredentialTree(root: CdpDomNode): CredentialTreeScan {
  const scan: CredentialTreeScan = { sensitive: [], opaqueFrames: [] };
  const stack: CdpDomNode[] = [root];
  let visited = 0;
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (++visited > MAX_NODES) throw new Error("The page is too large to check for password fields.");
    if (node.nodeType === ELEMENT_NODE) {
      const name = (node.localName ?? node.nodeName).toLowerCase();
      if (isSensitiveField(node)) scan.sensitive.push(node.backendNodeId);
      if (FRAME_ELEMENTS.has(name) && node.contentDocument === undefined) scan.opaqueFrames.push(node.backendNodeId);
    }
    // Reverse push keeps document order: shadow trees, then the frame's
    // document, then children (a template's inert content is never rendered).
    const next = [...(node.shadowRoots ?? []), ...(node.contentDocument ? [node.contentDocument] : []), ...(node.children ?? [])];
    for (let index = next.length - 1; index >= 0; index -= 1) stack.push(next[index]!);
  }
  return scan;
}

async function readTree(port: CdpPort): Promise<CredentialTreeScan> {
  const document = (await port.send("DOM.getDocument", { depth: -1, pierce: true })) as { root?: CdpDomNode };
  if (!document.root) throw new Error("The page's document could not be read.");
  return scanCredentialTree(document.root);
}

/** Backend node ids of the page's sensitive fields, without reading where they are. */
export async function sensitiveFieldIds(port: CdpPort): Promise<number[]> {
  return (await readTree(port)).sensitive;
}

/** The bounding rectangle of DevTools quads (`[x1, y1, … x4, y4]` each). */
export function quadsBounds(quads: readonly (readonly number[])[]): CssRect | undefined {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const quad of quads) {
    for (let index = 0; index + 1 < quad.length; index += 2) {
      const x = quad[index]!, y = quad[index + 1]!;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : undefined;
}

function intersectsViewport(rect: CssRect, viewport: { width: number; height: number }): boolean {
  return rect.x < viewport.width && rect.y < viewport.height && rect.x + rect.width > 0 && rect.y + rect.height > 0;
}

/**
 * Where a node is drawn, or `undefined` when it isn't rendered (`display:
 * none`, detached). Content quads cover every line box of an inline element;
 * the border box is the fallback.
 */
async function nodeBounds(port: CdpPort, backendNodeId: number): Promise<CssRect | undefined> {
  try {
    const result = (await port.send("DOM.getContentQuads", { backendNodeId })) as { quads?: number[][] };
    const bounds = quadsBounds(result.quads ?? []);
    if (bounds) return bounds;
  } catch {
    /* Not rendered, or no content quads: try the box model. */
  }
  try {
    const result = (await port.send("DOM.getBoxModel", { backendNodeId })) as { model?: { border?: number[] } };
    return result.model?.border ? quadsBounds([result.model.border]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read every sensitive field's box and count the visible frames that can't be
 * inspected. Boxes are CSS pixels relative to the top-level layout viewport,
 * with same-process frames already mapped into it.
 */
export async function sensitiveFieldBoxes(
  port: CdpPort,
  viewport: { width: number; height: number },
): Promise<SensitiveFieldBoxes> {
  const scan = await readTree(port);
  const fields: SensitiveFieldBoxes["fields"] = [];
  for (const backendNodeId of scan.sensitive) {
    const box = await nodeBounds(port, backendNodeId);
    if (box) fields.push({ backendNodeId, box });
  }
  let opaqueFrames = 0;
  for (const backendNodeId of scan.opaqueFrames) {
    const bounds = await nodeBounds(port, backendNodeId);
    if (bounds && intersectsViewport(bounds, viewport)) opaqueFrames += 1;
  }
  return { fields, sensitive: scan.sensitive, opaqueFrames };
}
