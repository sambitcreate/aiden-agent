// Which parts of a page hold a secret, read from the DevTools DOM tree in main.
//
// A "sensitive field" is a password input, or any element whose `autocomplete`
// names a credential, a one-time code or a payment card (plan §5.1.6). The
// walker reads `DOM.getDocument({ depth: -1, pierce: true })`, which reaches
// every shadow root and every frame rendered in the page's own process. A
// frame in another process (a cross-site iframe under site isolation) has no
// readable document there; it is reported as opaque, because a field inside
// it could not be found, so its pixels can't be masked.
//
// A field stays sensitive once it was: a "show password" toggle turns a
// password input into plain text, value and all. Each tab remembers the
// fields it has seen as sensitive (`SensitiveFieldMemory`), and every scan
// treats them as sensitive for the rest of their life.

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
  /** `::before`, `::after` and marker boxes, which the accessibility tree also lists. */
  pseudoElements?: CdpDomNode[];
  /** Set on frame owner elements (`iframe`, `frame`). */
  frameId?: string;
}

/** The DevTools protocol, as main reaches it through `webContents.debugger`. */
export interface CdpPort {
  call(method: string, params?: Record<string, unknown>): Promise<unknown>;
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
  /** Of `sensitive`, the fields that are sensitive only because they were (the page made them plain text since). */
  recalled: number[];
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
const NOTHING_REMEMBERED: ReadonlySet<number> = new Set();
/** Fields remembered per renderer process, and processes per tab: the most recent are kept. */
const REMEMBERED_FIELDS = 512;
const REMEMBERED_PROCESSES = 4;
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

/**
 * The fields one tab has seen as sensitive, by backend node id, so a field
 * the page turns into plain text stays sensitive. A backend node id is unique
 * within its renderer process and never reused there, so ids are kept per
 * process: after a cross-site navigation moves the tab to another process, a
 * node there can't be taken for a remembered one, and a page restored to the
 * earlier process still finds its fields remembered.
 */
export class SensitiveFieldMemory {
  private readonly processes = new Map<number, Set<number>>();

  /** The fields remembered in renderer process `processId`. */
  of(processId: number): ReadonlySet<number> {
    return this.processes.get(processId) ?? NOTHING_REMEMBERED;
  }

  remember(processId: number, ids: Iterable<number>): void {
    const known = this.processes.get(processId) ?? new Set<number>();
    // Most recent last, in both maps, so the oldest go first.
    this.processes.delete(processId);
    this.processes.set(processId, known);
    for (const id of ids) {
      known.delete(id);
      known.add(id);
    }
    for (const id of known) {
      if (known.size <= REMEMBERED_FIELDS) break;
      known.delete(id);
    }
    for (const process of this.processes.keys()) {
      if (this.processes.size <= REMEMBERED_PROCESSES) break;
      this.processes.delete(process);
    }
  }
}

/**
 * Sensitive fields and unreadable frames in a pierced `DOM.getDocument` tree.
 * A node in `remembered` is sensitive whatever its attributes say now.
 */
export function scanCredentialTree(root: CdpDomNode, remembered: ReadonlySet<number> = NOTHING_REMEMBERED): CredentialTreeScan {
  const scan: CredentialTreeScan = { sensitive: [], recalled: [], opaqueFrames: [] };
  const stack: CdpDomNode[] = [root];
  let visited = 0;
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (++visited > MAX_NODES) throw new Error("The page is too large to check for password fields.");
    if (node.nodeType === ELEMENT_NODE) {
      const name = (node.localName ?? node.nodeName).toLowerCase();
      if (isSensitiveField(node)) scan.sensitive.push(node.backendNodeId);
      else if (remembered.has(node.backendNodeId)) {
        scan.sensitive.push(node.backendNodeId);
        scan.recalled.push(node.backendNodeId);
      }
      if (FRAME_ELEMENTS.has(name) && node.contentDocument === undefined) scan.opaqueFrames.push(node.backendNodeId);
    }
    // Reverse push keeps document order: shadow trees, then the frame's
    // document, then children (a template's inert content is never rendered).
    const next = [...(node.shadowRoots ?? []), ...(node.contentDocument ? [node.contentDocument] : []), ...(node.children ?? [])];
    for (let index = next.length - 1; index >= 0; index -= 1) stack.push(next[index]!);
  }
  return scan;
}

/** The page's sensitive fields (`remembered` ones included) and unreadable frames. */
export async function scanSensitiveFields(port: CdpPort, remembered?: ReadonlySet<number>): Promise<CredentialTreeScan> {
  const document = (await port.call("DOM.getDocument", { depth: -1, pierce: true })) as { root?: CdpDomNode };
  if (!document.root) throw new Error("The page's document could not be read.");
  return scanCredentialTree(document.root, remembered);
}

/** Backend node ids of the page's sensitive fields, without reading where they are. */
export async function sensitiveFieldIds(port: CdpPort, remembered?: ReadonlySet<number>): Promise<number[]> {
  return (await scanSensitiveFields(port, remembered)).sensitive;
}

/**
 * Which nodes' accessible names, descriptions and values could include what a
 * sensitive field holds. Chromium names a table cell, a row, a checkbox whose
 * label wraps a card field or a fieldset whose legend holds one with the
 * field's live value (a password's too), so the accessibility tree can carry
 * it outside the field itself. Read from the same pierced DOM tree.
 */
export interface SensitiveFieldReach {
  /** The fields the reach was computed for. */
  readonly sensitive: ReadonlySet<number>;
  /** Every node the DOM read saw. A node it didn't see (added or removed since) is treated as one that reaches a field. */
  readonly known: ReadonlySet<number>;
  /** Nodes inside a sensitive field (its text, options, shadow tree), the field itself not included. */
  readonly inside: ReadonlySet<number>;
  /**
   * For each node, the fields its accessible name could read: through its
   * content (children, shadow trees, slotted and pseudo elements),
   * `aria-owns`, `aria-labelledby` and `<label>` elements, followed from node
   * to node. A field reads itself.
   */
  readonly reads: ReadonlyMap<number, ReadonlySet<number>>;
  /** For each node, the fields inside it (its flat-tree descendants), itself included. */
  readonly holds: ReadonlyMap<number, ReadonlySet<number>>;
  /** Each element's `aria-describedby` targets. */
  readonly describedBy: ReadonlyMap<number, readonly number[]>;
  /** Fields that may be named by what they hold, because they aren't an input, textarea or select (a contenteditable code field). */
  readonly selfNamed: ReadonlySet<number>;
}

/** Elements a `<label>` names (HTML labelable elements; a custom element may be a form-associated one). */
const LABELABLE: ReadonlySet<string> = new Set(["button", "input", "meter", "output", "progress", "select", "textarea"]);
const NATIVE_FIELDS: ReadonlySet<string> = new Set(["input", "textarea", "select"]);

/** What reaches each of `sensitive` in a pierced `DOM.getDocument` tree (see `SensitiveFieldReach`). */
export function sensitiveFieldReach(root: CdpDomNode, sensitive: ReadonlySet<number>): SensitiveFieldReach {
  const known = new Set<number>(), inside = new Set<number>(), selfNamed = new Set<number>();
  const parentOf = new Map<number, number>(), scopeOf = new Map<number, number>(), hostOf = new Map<number, number>();
  const ids = new Map<number, Map<string, number>>();
  const elementChildren = new Map<number, number[]>();
  // `into.get(b)` lists every `a` whose name reads `b` directly.
  const into = new Map<number, number[]>();
  const edge = (from: number, to: number): void => {
    const list = into.get(to);
    if (list) list.push(from);
    else into.set(to, [from]);
  };
  const references: Array<{ from: number; scope: number; value: string; kind: "name" | "description" | "for" }> = [];
  const labels = new Set<number>(), labelable: number[] = [], slots: number[] = [];
  const stack: Array<{ node: CdpDomNode; parent?: number; scope: number; under: boolean }> = [{ node: root, scope: root.backendNodeId, under: false }];
  let visited = 0;
  while (stack.length > 0) {
    const { node, parent, scope, under } = stack.pop()!;
    if (++visited > MAX_NODES) throw new Error("The page is too large to check for password fields.");
    const id = node.backendNodeId;
    known.add(id);
    if (parent !== undefined) {
      parentOf.set(id, parent);
      edge(parent, id);
    }
    if (under) inside.add(id);
    const element = node.nodeType === ELEMENT_NODE;
    if (element) {
      const name = (node.localName ?? node.nodeName).toLowerCase();
      scopeOf.set(id, scope);
      const own = attribute(node, "id");
      if (own) {
        const scoped = ids.get(scope) ?? new Map<string, number>();
        if (!scoped.has(own)) scoped.set(own, id);
        ids.set(scope, scoped);
      }
      for (const [attr, kind] of [["aria-labelledby", "name"], ["aria-owns", "name"], ["aria-describedby", "description"]] as const) {
        const value = attribute(node, attr);
        if (value) references.push({ from: id, scope, value, kind });
      }
      if (name === "label") {
        labels.add(id);
        const target = attribute(node, "for");
        if (target) references.push({ from: id, scope, value: target, kind: "for" });
      }
      if (LABELABLE.has(name) || name.includes("-")) labelable.push(id);
      if (name === "slot") slots.push(id);
      if (sensitive.has(id) && !NATIVE_FIELDS.has(name)) selfNamed.add(id);
      elementChildren.set(id, (node.children ?? []).filter((child) => child.nodeType === ELEMENT_NODE).map((child) => child.backendNodeId));
    }
    const below = under || (element && sensitive.has(id));
    const next: Array<{ node: CdpDomNode; parent: number; scope: number; under: boolean }> = [];
    for (const shadow of node.shadowRoots ?? []) {
      hostOf.set(shadow.backendNodeId, id);
      next.push({ node: shadow, parent: id, scope: shadow.backendNodeId, under: below });
    }
    if (node.contentDocument) next.push({ node: node.contentDocument, parent: id, scope: node.contentDocument.backendNodeId, under: below });
    for (const child of [...(node.pseudoElements ?? []), ...(node.children ?? [])]) next.push({ node: child, parent: id, scope, under: below });
    for (let index = next.length - 1; index >= 0; index -= 1) stack.push(next[index]!);
  }
  const describedBy = new Map<number, number[]>();
  for (const { from, scope, value, kind } of references) {
    const scoped = ids.get(scope);
    // Playwright splits id lists on spaces, Chromium on any whitespace: both are followed.
    const targets = [...new Set([...value.split(" "), ...value.split(/\s+/u)])].flatMap((ref) => {
      const target = ref ? scoped?.get(ref) : undefined;
      return target === undefined ? [] : [target];
    });
    if (kind === "description") describedBy.set(from, targets);
    // A label's `for` control is named by the label.
    else if (kind === "for") for (const control of targets) edge(control, from);
    else for (const target of targets) edge(from, target);
  }
  // A control is also named by every label around it in its own tree.
  for (const control of labelable) {
    const scope = scopeOf.get(control);
    for (let above = parentOf.get(control); above !== undefined && scopeOf.get(above) === scope; above = parentOf.get(above)) {
      if (labels.has(above)) edge(control, above);
    }
  }
  // A slot shows its host's children.
  for (const slot of slots) {
    const host = hostOf.get(scopeOf.get(slot) ?? -1);
    for (const child of host === undefined ? [] : elementChildren.get(host) ?? []) edge(slot, child);
  }
  const reads = new Map<number, Set<number>>(), holds = new Map<number, Set<number>>();
  const add = (map: Map<number, Set<number>>, node: number, field: number): void => {
    const set = map.get(node);
    if (set) set.add(field);
    else map.set(node, new Set([field]));
  };
  for (const field of sensitive) {
    if (!known.has(field)) continue;
    for (let node: number | undefined = field; node !== undefined; node = parentOf.get(node)) add(holds, node, field);
    const queue = [field];
    const seen = new Set<number>();
    while (queue.length > 0) {
      const node = queue.pop()!;
      if (seen.has(node)) continue;
      seen.add(node);
      add(reads, node, field);
      queue.push(...(into.get(node) ?? []));
    }
  }
  return { sensitive, known, inside, reads, holds, describedBy, selfNamed };
}

/** The page's sensitive fields (`remembered` and `also` included) and what reaches them, from one DOM read. */
export async function scanSensitiveFieldReach(
  port: CdpPort,
  remembered?: ReadonlySet<number>,
  also: Iterable<number> = [],
): Promise<SensitiveFieldReach> {
  const document = (await port.call("DOM.getDocument", { depth: -1, pierce: true })) as { root?: CdpDomNode };
  if (!document.root) throw new Error("The page's document could not be read.");
  const scan = scanCredentialTree(document.root, remembered);
  return sensitiveFieldReach(document.root, new Set([...scan.sensitive, ...also]));
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
    const result = (await port.call("DOM.getContentQuads", { backendNodeId })) as { quads?: number[][] };
    const bounds = quadsBounds(result.quads ?? []);
    if (bounds) return bounds;
  } catch {
    /* Not rendered, or no content quads: try the box model. */
  }
  try {
    const result = (await port.call("DOM.getBoxModel", { backendNodeId })) as { model?: { border?: number[] } };
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
  remembered?: ReadonlySet<number>,
): Promise<SensitiveFieldBoxes> {
  const scan = await scanSensitiveFields(port, remembered);
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
