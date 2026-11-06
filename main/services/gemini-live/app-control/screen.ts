// Builds Live's compact, numbered view of Aiden's own window from the DevTools
// accessibility tree (`Accessibility.getFullAXTree`) and a DOM snapshot
// (`DOMSnapshot.captureSnapshot`) of the same document. The DOM snapshot
// supplies what the accessibility tree can't: the Live guard attributes on
// ancestors, which fields hold secrets, and where each element is drawn.
//
// - Secret fields (passwords, one-time codes, card fields) never show a value,
//   and neither does any text field inside a `data-live-guard="you"` region,
//   which is where Aiden keeps credential and API key fields.
// - Controls inside a "you" region are listed as only the user's to use;
//   controls inside a "confirm" region say they ask the user first.
// - The list is bounded: an open dialog comes first, then what matches
//   `focus`, then what is visible, and the rest is counted as omitted.

import { isSensitiveField } from "../../browser/credential-fields.js";
import type { LiveGuard } from "../../../../renderer/shared/live-app-control.js";

export interface CdpAxValue {
  type?: string;
  value?: unknown;
}

export interface CdpAxNode {
  nodeId: string;
  ignored?: boolean;
  role?: CdpAxValue;
  name?: CdpAxValue;
  value?: CdpAxValue;
  properties?: Array<{ name: string; value?: CdpAxValue }>;
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
}

/** The parts of `DOMSnapshot.captureSnapshot` the builder reads. */
export interface CdpDomSnapshot {
  documents: Array<{
    nodes: {
      parentIndex?: number[];
      nodeName?: number[];
      backendNodeId?: number[];
      /** Per node, flat `[name, value, …]` string-table indexes. */
      attributes?: number[][];
    };
    layout: { nodeIndex: number[]; bounds: number[][] };
  }>;
  strings: string[];
}

/** The visible part of the page, in the same CSS pixels as the snapshot's layout bounds. */
export interface ScreenViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AidenScreenElement {
  /** The number Live uses for this element until the next look. */
  ref: number;
  backendNodeId: number;
  role: string;
  name: string;
  guard: LiveGuard | null;
  /** Name of the dialog the element is in, if any. */
  dialog: string | null;
}

export interface AidenScreen {
  text: string;
  elements: AidenScreenElement[];
  /** Interactive elements on the page that were left out of the list. */
  omitted: number;
  /** role + name of every listed element, to mark new ones on the next look. */
  signatures: ReadonlySet<string>;
}

export interface AidenScreenLimits {
  elements: number;
  characters: number;
}

export const AIDEN_SCREEN_LIMITS: AidenScreenLimits = { elements: 200, characters: 12_000 };

export const AIDEN_SCREEN_MARKS = {
  you: "(only you can use this)",
  confirm: "(asks the user first)",
  added: "(new)",
} as const;

const ROLE_ALIASES: Record<string, string> = {
  PopUpButton: "select",
  ComboBoxSelect: "select",
  ComboBoxMenuButton: "select",
  MenuListOption: "option",
  ToggleButton: "button",
  DisclosureTriangle: "button",
};

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "checkbox",
  "switch",
  "radio",
  "combobox",
  "select",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "tab",
  "slider",
  "spinbutton",
  "textbox",
  "searchbox",
  "treeitem",
]);

const TEXT_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);
const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "select", "slider", "spinbutton"]);
const DIALOG_ROLES = new Set(["dialog", "alertdialog"]);
const LANDMARK_ROLES = new Set([
  "navigation",
  "main",
  "complementary",
  "banner",
  "contentinfo",
  "region",
  "form",
  "search",
]);
const MAX_ORIENTATION_LINES = 40;
const MAX_NAME = 80;
const MAX_VALUE = 80;
const MAX_FOCUS = 80;

interface DomFacts {
  guard: LiveGuard | null;
  secret: boolean;
  visible: boolean;
}

function attributePairs(strings: string[], indexes: number[] | undefined): string[] {
  return (indexes ?? []).map((index) => strings[index] ?? "");
}

function ownGuard(attributes: string[]): LiveGuard | null {
  let guard: LiveGuard | null = null;
  for (let index = 0; index + 1 < attributes.length; index += 2) {
    const name = attributes[index]!.toLowerCase();
    const value = attributes[index + 1]!.trim().toLowerCase();
    if (name === "data-onboarding-active" && value === "true") return "you";
    if (name === "data-live-guard") {
      if (value === "you") return "you";
      if (value === "confirm") guard = "confirm";
    }
  }
  return guard;
}

function intersects(bounds: number[] | undefined, viewport: ScreenViewport): boolean {
  if (!bounds || bounds.length < 4) return false;
  const [x, y, width, height] = bounds as [number, number, number, number];
  if (!(width > 0 && height > 0)) return false;
  return (
    x < viewport.x + viewport.width &&
    x + width > viewport.x &&
    y < viewport.y + viewport.height &&
    y + height > viewport.y
  );
}

/** Guard, secret and visibility facts for every DOM node, by backend node id. */
export function domFacts(snapshot: CdpDomSnapshot, viewport: ScreenViewport): Map<number, DomFacts> {
  const facts = new Map<number, DomFacts>();
  for (const document of snapshot.documents ?? []) {
    const nodes = document.nodes ?? {};
    const backendIds = nodes.backendNodeId ?? [];
    const parents = nodes.parentIndex ?? [];
    const visible = new Set<number>();
    const layout = document.layout ?? { nodeIndex: [], bounds: [] };
    for (let index = 0; index < layout.nodeIndex.length; index += 1) {
      if (intersects(layout.bounds[index], viewport)) visible.add(layout.nodeIndex[index]!);
    }
    const guards: Array<LiveGuard | null | undefined> = new Array(backendIds.length);
    const guardOf = (start: number): LiveGuard | null => {
      // Walk up to the nearest node whose guard is known, then fill the path.
      const path: number[] = [];
      let index = start;
      let inherited: LiveGuard | null = null;
      while (index >= 0 && index < backendIds.length) {
        const known = guards[index];
        if (known !== undefined) {
          inherited = known;
          break;
        }
        path.push(index);
        index = parents[index] ?? -1;
      }
      for (let step = path.length - 1; step >= 0; step -= 1) {
        const node = path[step]!;
        const own = ownGuard(attributePairs(snapshot.strings, nodes.attributes?.[node]));
        inherited = own === "you" || inherited === "you" ? "you" : (own ?? inherited);
        guards[node] = inherited;
      }
      return inherited;
    };
    for (let index = 0; index < backendIds.length; index += 1) {
      const name = snapshot.strings[nodes.nodeName?.[index] ?? -1] ?? "";
      facts.set(backendIds[index]!, {
        guard: guardOf(index),
        secret: isSensitiveField({
          localName: name.toLowerCase(),
          attributes: attributePairs(snapshot.strings, nodes.attributes?.[index]),
        }),
        visible: visible.has(index),
      });
    }
  }
  return facts;
}

function text(value: CdpAxValue | undefined): string {
  const raw = value?.value;
  if (typeof raw === "string") return raw.replace(/\s+/gu, " ").trim();
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return "";
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function quote(value: string): string {
  return `“${value.replace(/[“”]/gu, '"')}”`;
}

function property(node: CdpAxNode, name: string): unknown {
  return node.properties?.find((entry) => entry.name === name)?.value?.value;
}

function role(node: CdpAxNode): string {
  const raw = typeof node.role?.value === "string" ? node.role.value : "";
  return ROLE_ALIASES[raw] ?? raw;
}

function states(node: CdpAxNode, nodeRole: string): string[] {
  const out: string[] = [];
  const checked = property(node, "checked");
  if (checked === "true" || checked === true) out.push("checked");
  else if (checked === "mixed") out.push("mixed");
  else if (
    (checked === "false" || checked === false) &&
    ["checkbox", "switch", "radio", "menuitemcheckbox", "menuitemradio"].includes(nodeRole)
  ) {
    out.push("not checked");
  }
  const pressed = property(node, "pressed");
  if (pressed === "true" || pressed === true) out.push("pressed");
  const expanded = property(node, "expanded");
  if (expanded === true) out.push("expanded");
  else if (expanded === false) out.push("collapsed");
  if (property(node, "selected") === true) out.push("selected");
  if (property(node, "disabled") === true) out.push("disabled");
  if (property(node, "focused") === true) out.push("focused");
  return out;
}

interface Item {
  order: number;
  kind: "element" | "orientation";
  line: (ref: number) => string;
  score: number;
  element?: Omit<AidenScreenElement, "ref">;
}

/**
 * Builds the numbered list. Numbers follow page order among the elements that
 * fit; the caller keeps `elements` to resolve the numbers Live sends back.
 */
export function buildAidenScreen(input: {
  ax: { nodes?: CdpAxNode[] };
  dom: CdpDomSnapshot;
  viewport: ScreenViewport;
  focus?: string;
  limits?: AidenScreenLimits;
  previous?: ReadonlySet<string>;
}): AidenScreen {
  const limits = input.limits ?? AIDEN_SCREEN_LIMITS;
  const facts = domFacts(input.dom, input.viewport);
  const nodes = input.ax.nodes ?? [];
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const focus = clip((input.focus ?? "").replace(/\s+/gu, " ").trim().toLowerCase(), MAX_FOCUS);
  const matches = (value: string) => focus.length > 0 && value.toLowerCase().includes(focus);
  const root = nodes.find((node) => !node.parentId || !byId.has(node.parentId)) ?? nodes[0];

  const items: Item[] = [];
  let focusedName = "";
  const dialogs: string[] = [];
  let order = 0;
  // Iterative depth-first walk in page order; context travels with each entry.
  const stack: Array<{ id: string; dialog: string | null; region: boolean }> = root
    ? [{ id: root.nodeId, dialog: null, region: false }]
    : [];
  const seen = new Set<string>();
  let lastHeading = "";
  while (stack.length > 0) {
    const entry = stack.pop()!;
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const node = byId.get(entry.id);
    if (!node) continue;
    let dialog = entry.dialog;
    let region = entry.region;
    if (!node.ignored) {
      const nodeRole = role(node);
      const name = clip(text(node.name), MAX_NAME);
      const dom = node.backendDOMNodeId !== undefined ? facts.get(node.backendDOMNodeId) : undefined;
      const visible = dom?.visible === true;
      if (DIALOG_ROLES.has(nodeRole)) {
        dialog = name || "Dialog";
        if (visible) dialogs.push(dialog);
        region = region || matches(name);
        const label = `[${nodeRole} ${quote(dialog)}]`;
        items.push({ order: order++, kind: "orientation", line: () => label, score: 1_000 });
      } else if (LANDMARK_ROLES.has(nodeRole) && (name || nodeRole === "main")) {
        region = region || matches(name);
        const label = name ? `[${nodeRole} ${quote(name)}]` : `[${nodeRole}]`;
        items.push({
          order: order++,
          kind: "orientation",
          line: () => label,
          score: (visible ? 10 : 0) + (dialog ? 100 : 0) + (region ? 50 : 0),
        });
      } else if (nodeRole === "heading" && name) {
        lastHeading = name;
        const label = `# ${name}`;
        items.push({
          order: order++,
          kind: "orientation",
          line: () => label,
          score: (visible ? 10 : 0) + (dialog ? 100 : 0) + (region || matches(name) ? 50 : 0),
        });
      } else if (nodeRole === "alert" && name) {
        const label = `! ${name}`;
        items.push({ order: order++, kind: "orientation", line: () => label, score: visible ? 20 : 0 });
      } else if (INTERACTIVE_ROLES.has(nodeRole) && node.backendDOMNodeId !== undefined) {
        const guard = dom?.guard ?? null;
        const nodeStates = states(node, nodeRole);
        if (nodeStates.includes("focused")) focusedName = name || nodeRole;
        // Credential and API key fields live in "you" regions; their text never leaves.
        const hideValue = dom?.secret === true || (guard === "you" && TEXT_ROLES.has(nodeRole));
        const rawValue = VALUE_ROLES.has(nodeRole) && !hideValue ? clip(text(node.value), MAX_VALUE) : "";
        const value = rawValue && rawValue !== name ? rawValue : "";
        const signature = `${nodeRole}\u0000${name}`;
        const marks = [
          ...(nodeStates.length ? [`(${nodeStates.join(", ")})`] : []),
          ...(guard ? [AIDEN_SCREEN_MARKS[guard]] : []),
          ...(input.previous && !input.previous.has(signature) ? [AIDEN_SCREEN_MARKS.added] : []),
        ];
        const description = `${nodeRole}${name ? ` ${quote(name)}` : ""}${value ? ` = ${quote(value)}` : ""}${marks.length ? ` ${marks.join(" ")}` : ""}`;
        items.push({
          order: order++,
          kind: "element",
          line: (ref) => `${ref} ${description}`,
          score:
            1 +
            (name ? 1 : 0) +
            (visible ? 10 : 0) +
            (nodeStates.includes("focused") ? 5 : 0) +
            (dialog ? 100 : 0) +
            (region || matches(name) || matches(lastHeading) ? 50 : 0),
          element: {
            backendNodeId: node.backendDOMNodeId,
            role: nodeRole,
            name,
            guard,
            dialog,
          },
        });
      }
    }
    const children = node.childIds ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ id: children[index]!, dialog, region });
    }
  }

  const title = clip(text(root?.name), MAX_NAME);
  const header = [
    `Aiden window${title ? ` ${quote(title)}` : ""}.`,
    ...(dialogs.length ? [`A dialog is open: ${quote(dialogs[dialogs.length - 1]!)}.`] : []),
    ...(focusedName ? [`Focused: ${quote(focusedName)}.`] : []),
  ].join(" ");
  // Reserve room for the header and the omitted-count footer.
  let characters = header.length + 160;
  let elementCount = 0;
  let orientationCount = 0;
  const chosen = new Set<number>();
  const ranked = [...items].sort((left, right) => right.score - left.score || left.order - right.order);
  for (const item of ranked) {
    if (item.kind === "element" && elementCount >= limits.elements) continue;
    if (item.kind === "orientation" && (orientationCount >= MAX_ORIENTATION_LINES || item.score < 10)) continue;
    // Numbers are at most three digits under the element limit.
    const cost = item.line(limits.elements).length + 1;
    if (characters + cost > limits.characters) continue;
    characters += cost;
    chosen.add(item.order);
    if (item.kind === "element") elementCount += 1;
    else orientationCount += 1;
  }

  const lines: string[] = [header];
  const elements: AidenScreenElement[] = [];
  const signatures = new Set<string>();
  let omitted = 0;
  for (const item of items) {
    if (!chosen.has(item.order)) {
      if (item.kind === "element") omitted += 1;
      continue;
    }
    if (item.kind === "orientation") {
      lines.push(item.line(0));
      continue;
    }
    const ref = elements.length + 1;
    elements.push({ ref, ...item.element! });
    signatures.add(`${item.element!.role}\u0000${item.element!.name}`);
    lines.push(item.line(ref));
  }
  if (elements.length === 0) lines.push("Nothing to press or type in is showing.");
  if (omitted > 0) {
    lines.push(`${omitted} more controls are not listed. Look again with a focus to narrow it down.`);
  }
  return { text: lines.join("\n"), elements, omitted, signatures };
}
