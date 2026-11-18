// Tweaks: a page's own controls, and the Dark switch.
//
// A page declares its controls in one JSON block:
//
//   <script type="application/aiden-tweaks">
//   { "controls": [
//     { "id": "accent", "label": "Accent", "type": "color", "default": "#2f6fed", "var": "--accent", "group": "Colour" },
//     { "id": "density", "label": "Density", "type": "choice", "options": ["compact", "cozy"],
//       "default": "cozy", "attr": "data-density" },
//     { "id": "radius", "label": "Corners", "type": "number", "min": 0, "max": 24, "step": 2,
//       "unit": "px", "default": 8, "var": "--radius", "group": "Shape" },
//     { "id": "promo", "label": "Promo banner", "type": "switch", "default": true, "attr": "data-promo" },
//     { "id": "headline", "label": "Headline", "type": "text", "default": "Make room to play", "attr": "data-headline" },
//     { "id": "shadow", "label": "Shadow", "type": "pad",
//       "x": { "label": "Distance", "var": "--shadow-y", "min": 0, "max": 32, "unit": "px", "default": 8 },
//       "y": { "label": "Blur", "var": "--shadow-blur", "min": 0, "max": 64, "unit": "px", "default": 24 } },
//     { "id": "replay", "label": "Replay animation", "type": "action" }
//   ] }
//   </script>
//
// Each control sets one CSS variable or one `data-*` attribute on the page's
// root element; a pad sets two (one per axis), and an action sets none: it
// tells the page through an `aiden-tweak-action` event. A text control also
// fills every `[data-aiden-text="<name>"]` element, where name is its
// attribute without `data-`. A control's `group` puts it in a folder.
//
// The frame keeps only the values the person changed, keyed by target
// (`tweaks`), so the bridge can apply them without the declaration, and an
// export draws the same page. Nothing is written to the page's file. Pure, so
// it is tested without a DOM.

export type DesignTweakTarget = { var: string } | { attr: string };

/** One axis of a pad: a number like a slider's, with its own target and label. */
export type DesignTweakAxis = {
  label: string;
  target: DesignTweakTarget;
  min: number;
  max: number;
  step: number;
  unit: string;
  default: number;
};

export type DesignTweakControl = { id: string; label: string; group?: string } & (
  | { type: "switch"; target: DesignTweakTarget; default: boolean }
  | { type: "choice"; target: DesignTweakTarget; options: string[]; default: string }
  | { type: "number"; target: DesignTweakTarget; min: number; max: number; step: number; unit: string; default: number }
  | { type: "color"; target: DesignTweakTarget; default: string }
  | { type: "text"; target: { attr: string }; default: string }
  | { type: "pad"; x: DesignTweakAxis; y: DesignTweakAxis }
  | { type: "action" }
);

/** A pad's value: one number per axis. */
export type DesignTweakPoint = { x: number; y: number };

/** What a control shows and takes. An action has none. */
export type DesignTweakValue = boolean | string | number | DesignTweakPoint;

/** A frame's changed values: target name (`--x` or `data-x`) to the text the page gets. */
export type DesignTweakValues = Record<string, string>;

export const DESIGN_TWEAK_LIMITS = {
  /** Targets a page may declare, counting both axes of a pad. Actions are not counted. */
  controls: 24,
  actions: 8,
  groups: 8,
  labelChars: 60,
  groupChars: 40,
  options: 12,
  optionChars: 40,
  valueChars: 100,
  /** How far into a page's HTML the declaration is looked for. */
  scanChars: 512 * 1024,
} as const;

const ID = /^[A-Za-z0-9_-]{1,40}$/u;
const VAR = /^--[A-Za-z0-9_-]{1,60}$/u;
const ATTR = /^data-[a-z0-9-]{1,60}$/u;
const HEX = /^#[0-9a-f]{6}$/iu;
/** What a value may never hold: it ends up in a style property or an attribute. */
const UNSAFE = /[;{}<>\\"']|url\(|expression\(/iu;
const UNIT = /^(px|rem|em|%|ms|s|deg|vw|vh|)$/u;

export function isDesignTweakTarget(name: unknown): name is string {
  return typeof name === "string" && (VAR.test(name) || ATTR.test(name));
}

export function isDesignTweakValue(value: unknown): value is string {
  return typeof value === "string" && value.length <= DESIGN_TWEAK_LIMITS.valueChars && !UNSAFE.test(value);
}

/**
 * Words typed into a text control, made safe for the page: straight quotes
 * become curly ones, characters a value can't hold are dropped, line breaks
 * become spaces, and it is cut to the value limit.
 */
export function cleanDesignTweakText(value: string): string {
  let open = true;
  return value
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/'/gu, "\u2019")
    .replace(/"/gu, () => {
      const mark = open ? "\u201c" : "\u201d";
      open = !open;
      return mark;
    })
    .replace(/[;{}<>\\]/gu, "")
    .replace(/(url|expression)\(/giu, "$1 (")
    .slice(0, DESIGN_TWEAK_LIMITS.valueChars);
}

/** Reads a stored `tweaks` record: bounded, safe names and values only, or undefined when none are left. */
export function parseDesignTweakValues(value: unknown): DesignTweakValues | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const values: DesignTweakValues = {};
  let count = 0;
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (count >= DESIGN_TWEAK_LIMITS.controls) break;
    if (!isDesignTweakTarget(name) || !isDesignTweakValue(entry)) continue;
    values[name] = entry;
    count += 1;
  }
  return count > 0 ? values : undefined;
}

export function tweakTargetName(target: DesignTweakTarget): string {
  return "var" in target ? target.var : target.attr;
}

/** Every target a control sets: one, two for a pad, none for an action. */
export function designTweakTargets(control: DesignTweakControl): DesignTweakTarget[] {
  switch (control.type) {
    case "pad":
      return [control.x.target, control.y.target];
    case "action":
      return [];
    default:
      return [control.target];
  }
}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, max) : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000 ? value : null;
}

function targetOf(entry: Record<string, unknown>): DesignTweakTarget | null {
  if (typeof entry.var === "string" && VAR.test(entry.var)) return { var: entry.var };
  if (typeof entry.attr === "string" && ATTR.test(entry.attr)) return { attr: entry.attr };
  return null;
}

/** A number's range, step, unit and default, as a slider and each pad axis read them. */
function range(entry: Record<string, unknown>): { min: number; max: number; step: number; unit: string; default: number } | null {
  const min = number(entry.min) ?? 0;
  const max = number(entry.max) ?? 100;
  if (max <= min) return null;
  const step = number(entry.step);
  const unit = typeof entry.unit === "string" && UNIT.test(entry.unit) ? entry.unit : "";
  const fallback = number(entry.default);
  return {
    min,
    max,
    step: step !== null && step > 0 ? step : 1,
    unit,
    default: fallback === null ? min : Math.min(max, Math.max(min, fallback)),
  };
}

function axis(raw: unknown, fallbackLabel: string): DesignTweakAxis | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const target = targetOf(entry);
  const numbers = range(entry);
  if (!target || !numbers) return null;
  return { label: text(entry.label, DESIGN_TWEAK_LIMITS.labelChars) ?? fallbackLabel, target, ...numbers };
}

function control(raw: unknown): DesignTweakControl | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const id = typeof entry.id === "string" && ID.test(entry.id) ? entry.id : null;
  if (!id) return null;
  const label = text(entry.label, DESIGN_TWEAK_LIMITS.labelChars) ?? id;
  const group = text(entry.group, DESIGN_TWEAK_LIMITS.groupChars);
  const base = { id, label, ...(group ? { group } : {}) };
  if (entry.type === "action") return { ...base, type: "action" };
  if (entry.type === "pad") {
    const x = axis(entry.x, "X");
    const y = axis(entry.y, "Y");
    if (!x || !y || tweakTargetName(x.target) === tweakTargetName(y.target)) return null;
    return { ...base, type: "pad", x, y };
  }
  const target = targetOf(entry);
  if (!target) return null;
  if (entry.type === "switch") {
    return { ...base, target, type: "switch", default: entry.default === true };
  }
  if (entry.type === "choice") {
    if (!Array.isArray(entry.options)) return null;
    const options = [
      ...new Set(
        entry.options
          .map((option) => text(option, DESIGN_TWEAK_LIMITS.optionChars))
          .filter((option): option is string => option !== null && isDesignTweakValue(option)),
      ),
    ].slice(0, DESIGN_TWEAK_LIMITS.options);
    if (options.length < 2) return null;
    const fallback = typeof entry.default === "string" && options.includes(entry.default) ? entry.default : options[0]!;
    return { ...base, target, type: "choice", options, default: fallback };
  }
  if (entry.type === "number") {
    const numbers = range(entry);
    return numbers ? { ...base, target, type: "number", ...numbers } : null;
  }
  if (entry.type === "color") {
    const fallback = typeof entry.default === "string" && HEX.test(entry.default) ? entry.default.toLowerCase() : "#000000";
    return { ...base, target, type: "color", default: fallback };
  }
  if (entry.type === "text") {
    // Words go on an attribute and into elements, never into a style property.
    if (!("attr" in target)) return null;
    const fallback = typeof entry.default === "string" ? cleanDesignTweakText(entry.default) : "";
    return { ...base, target, type: "text", default: fallback };
  }
  return null;
}

/**
 * Reads a declaration's JSON: `{ "controls": [...] }` or a bare array. Two
 * controls never share an id or a target; at most 24 targets (a pad counts
 * twice), 8 actions and 8 folders are kept, in the order they are written. A
 * control past the eighth folder is kept outside any folder.
 */
export function parseDesignTweakControls(value: unknown): DesignTweakControl[] {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { controls?: unknown }).controls)
      ? (value as { controls: unknown[] }).controls
      : [];
  const ids = new Set<string>();
  const targets = new Set<string>();
  const groups = new Set<string>();
  const controls: DesignTweakControl[] = [];
  let actions = 0;
  for (const raw of list) {
    const found = control(raw);
    if (!found || ids.has(found.id)) continue;
    const names = designTweakTargets(found).map(tweakTargetName);
    if (names.some((name) => targets.has(name))) continue;
    if (found.type === "action") {
      if (actions >= DESIGN_TWEAK_LIMITS.actions) continue;
      actions += 1;
    } else if (targets.size + names.length > DESIGN_TWEAK_LIMITS.controls) continue;
    if (found.group !== undefined && !groups.has(found.group)) {
      if (groups.size >= DESIGN_TWEAK_LIMITS.groups) delete found.group;
      else groups.add(found.group);
    }
    ids.add(found.id);
    for (const name of names) targets.add(name);
    controls.push(found);
  }
  return controls;
}

const DECLARATION = /<script\b[^>]*\btype\s*=\s*["']?application\/aiden-tweaks["']?[^>]*>([\s\S]*?)<\/script\s*>/iu;

/** Finds a page's declaration and reads it; a page without one, or with broken JSON, has no controls. */
export function extractDesignTweakControls(html: string): DesignTweakControl[] {
  const match = DECLARATION.exec(html.slice(0, DESIGN_TWEAK_LIMITS.scanChars));
  if (!match) return [];
  try {
    return parseDesignTweakControls(JSON.parse(match[1]!));
  } catch {
    return [];
  }
}

function formatNumber(numbers: { min: number; max: number; default: number }, unit: string, value: unknown): string {
  const raw = typeof value === "number" ? value : Number(value);
  const clamped = Math.min(numbers.max, Math.max(numbers.min, Number.isFinite(raw) ? raw : numbers.default));
  return `${Number(clamped.toFixed(4))}${unit}`;
}

function readNumber(numbers: { min: number; max: number; default: number }, stored: string | undefined): number {
  if (stored === undefined) return numbers.default;
  const parsed = Number.parseFloat(stored);
  return Number.isFinite(parsed) ? Math.min(numbers.max, Math.max(numbers.min, parsed)) : numbers.default;
}

function point(value: DesignTweakValue | undefined): DesignTweakPoint | null {
  return value && typeof value === "object" && typeof value.x === "number" && typeof value.y === "number" ? value : null;
}

/**
 * The text each of a control's targets puts on the page, keyed by target.
 * An action has none.
 */
export function formatDesignTweakTargets(control: DesignTweakControl, value: DesignTweakValue): Record<string, string> {
  switch (control.type) {
    case "pad": {
      const at = point(value) ?? { x: control.x.default, y: control.y.default };
      const unitOf = (entry: DesignTweakAxis) => ("var" in entry.target ? entry.unit : "");
      return {
        [tweakTargetName(control.x.target)]: formatNumber(control.x, unitOf(control.x), at.x),
        [tweakTargetName(control.y.target)]: formatNumber(control.y, unitOf(control.y), at.y),
      };
    }
    case "action":
      return {};
    default:
      return { [tweakTargetName(control.target)]: formatDesignTweak(control, value) };
  }
}

/** The text a single-target control's value puts on the page. */
export function formatDesignTweak(
  control: Exclude<DesignTweakControl, { type: "pad" | "action" }>,
  value: DesignTweakValue,
): string {
  switch (control.type) {
    case "switch":
      // A variable gets 1 or 0, for `calc()`; an attribute gets "true" or "false", for selectors.
      return "var" in control.target ? (value ? "1" : "0") : value ? "true" : "false";
    case "number":
      return formatNumber(control, "var" in control.target ? control.unit : "", value);
    case "choice":
      return typeof value === "string" && control.options.includes(value) ? value : control.default;
    case "color":
      return typeof value === "string" && HEX.test(value) ? value.toLowerCase() : control.default;
    case "text":
      return typeof value === "string" ? cleanDesignTweakText(value) : control.default;
  }
}

/** A control's default value: what the panel shows before anything changes. */
export function designTweakDefault(control: DesignTweakControl): DesignTweakValue {
  if (control.type === "action") return false;
  return control.type === "pad" ? { x: control.x.default, y: control.y.default } : control.default;
}

/** What the panel shows for a control: the frame's value read back, or the page's default. */
export function readDesignTweak(control: DesignTweakControl, values: DesignTweakValues | undefined): DesignTweakValue {
  if (control.type === "action") return false;
  if (control.type === "pad") {
    return {
      x: readNumber(control.x, values?.[tweakTargetName(control.x.target)]),
      y: readNumber(control.y, values?.[tweakTargetName(control.y.target)]),
    };
  }
  const stored = values?.[tweakTargetName(control.target)];
  if (stored === undefined) return control.default;
  switch (control.type) {
    case "switch":
      return stored === "1" || stored === "true";
    case "number":
      return readNumber(control, stored);
    case "choice":
      return control.options.includes(stored) ? stored : control.default;
    case "color":
      return HEX.test(stored) ? stored.toLowerCase() : control.default;
    case "text":
      return isDesignTweakValue(stored) ? stored : control.default;
  }
}

/**
 * The frame's values after one control changes. A value equal to the page's
 * default is dropped, so Reset and "back to the default" both leave the page
 * as its file says. Undefined when nothing is left. An action changes nothing.
 */
export function withDesignTweak(
  values: DesignTweakValues | undefined,
  control: DesignTweakControl,
  value: DesignTweakValue,
): DesignTweakValues | undefined {
  if (control.type === "action") return values;
  const next: DesignTweakValues = { ...values };
  const formatted = formatDesignTweakTargets(control, value);
  const defaults = formatDesignTweakTargets(control, designTweakDefault(control));
  for (const [name, text] of Object.entries(formatted)) {
    if (text === defaults[name]) delete next[name];
    else next[name] = text;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/** What the bridge applies: the Dark switch and the frame's values, split by kind of target. */
export type DesignTweakState = { dark: boolean; vars: Record<string, string>; attrs: Record<string, string> };

export function designTweakState(frame: { dark?: true; tweaks?: DesignTweakValues }): DesignTweakState {
  const state: DesignTweakState = { dark: frame.dark === true, vars: {}, attrs: {} };
  for (const [name, value] of Object.entries(parseDesignTweakValues(frame.tweaks) ?? {})) {
    if (VAR.test(name)) state.vars[name] = value;
    else state.attrs[name] = value;
  }
  return state;
}

export const DESIGN_TWEAKS_PARAM = "aiden-tweaks";
export const DESIGN_DARK_PARAM = "aiden-dark";

/**
 * A page's address with its tweaks, for an export and a page's first load:
 * the bridge reads these before the page draws, so it never flashes light.
 * The scheme ignores the query when it looks the file up.
 */
export function withDesignTweakQuery(url: string, state: DesignTweakState): string {
  const params: string[] = [];
  if (state.dark) params.push(`${DESIGN_DARK_PARAM}=1`);
  if (Object.keys(state.vars).length > 0 || Object.keys(state.attrs).length > 0) {
    params.push(`${DESIGN_TWEAKS_PARAM}=${encodeURIComponent(JSON.stringify({ vars: state.vars, attrs: state.attrs }))}`);
  }
  if (params.length === 0) return url;
  const hash = url.indexOf("#");
  const base = hash === -1 ? url : url.slice(0, hash);
  const fragment = hash === -1 ? "" : url.slice(hash);
  return `${base}${base.includes("?") ? "&" : "?"}${params.join("&")}${fragment}`;
}

// ---- Make default ----------------------------------------------------------
//
// Writing the frame's values into the page's file, so they become what the
// page starts with. The declaration's defaults change, and the page's look
// follows the same rules the bridge uses: variables go in one managed
// `<style data-aiden-tweaks>` block on `:root`, attributes on the `<html>`
// tag, and a text control's words replace its old default where that text
// stands once in the page. Anything that can't be placed stays on the frame.

export type DesignTweakBake =
  | {
      ok: true;
      source: string;
      /** Targets whose value stays on the frame: words that weren't found exactly once. */
      kept: string[];
      /** The text controls' words to change in the page, as plain text changes. */
      textChanges: { target: string; before: string; after: string }[];
    }
  | { ok: false; reason: "not-found" | "unchanged" };

const TWEAK_STYLE = /<style\b[^>]*\bdata-aiden-tweaks\b[^>]*>([\s\S]*?)<\/style\s*>/iu;
const HTML_TAG = /<html\b[^>]*>/iu;

/** Sets or adds one attribute on an opening tag. Values are already safe (no quotes). */
function withAttribute(tag: string, name: string, value: string): string {
  const existing = new RegExp(`(\\s${name})(\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+))?`, "iu");
  if (existing.test(tag)) return tag.replace(existing, `$1="${value}"`);
  return tag.replace(/\s*\/?>$/u, (end) => ` ${name}="${value}"${end.trim()}`);
}

function withTweakStyle(source: string, vars: Record<string, string>): string {
  const found = TWEAK_STYLE.exec(source);
  const merged = new Map<string, string>();
  if (found) {
    for (const match of found[1]!.matchAll(/(--[A-Za-z0-9_-]{1,60})\s*:\s*([^;}]*)/gu)) merged.set(match[1]!, match[2]!.trim());
  }
  for (const [name, value] of Object.entries(vars)) merged.set(name, value);
  const body = `:root { ${[...merged].map(([name, value]) => `${name}: ${value};`).join(" ")} }`;
  const block = `<style data-aiden-tweaks>\n${body}\n</style>`;
  if (found) return source.slice(0, found.index) + block + source.slice(found.index + found[0].length);
  const head = /<\/head\s*>/iu.exec(source);
  if (head) return `${source.slice(0, head.index)}${block}\n${source.slice(head.index)}`;
  const html = HTML_TAG.exec(source);
  if (html) {
    const at = html.index + html[0].length;
    return `${source.slice(0, at)}\n${block}${source.slice(at)}`;
  }
  return `${block}\n${source}`;
}

/**
 * The page's file with the frame's values made its defaults. Pure: main reads
 * and writes the file, and places the text changes with the text-edit rules.
 */
export function bakeDesignTweakDefaults(source: string, values: DesignTweakValues | undefined): DesignTweakBake {
  const scanned = source.slice(0, DESIGN_TWEAK_LIMITS.scanChars);
  const match = DECLARATION.exec(scanned);
  if (!match) return { ok: false, reason: "not-found" };
  let json: unknown;
  try {
    json = JSON.parse(match[1]!);
  } catch {
    return { ok: false, reason: "not-found" };
  }
  const list: unknown[] = Array.isArray(json)
    ? json
    : json && typeof json === "object" && Array.isArray((json as { controls?: unknown }).controls)
      ? (json as { controls: unknown[] }).controls
      : [];
  const controls = parseDesignTweakControls(json);
  const vars: Record<string, string> = {};
  const attrs: Record<string, string> = {};
  const textChanges: { target: string; before: string; after: string }[] = [];
  let changed = false;
  for (const control of controls) {
    if (control.type === "action") continue;
    const value = readDesignTweak(control, values);
    const formatted = formatDesignTweakTargets(control, value);
    const defaults = formatDesignTweakTargets(control, designTweakDefault(control));
    const differing = Object.keys(formatted).filter((name) => formatted[name] !== defaults[name]);
    if (differing.length === 0) continue;
    changed = true;
    const raw = list.find(
      (entry): entry is Record<string, unknown> =>
        Boolean(entry) && typeof entry === "object" && (entry as { id?: unknown }).id === control.id,
    );
    if (!raw) continue;
    if (control.type === "pad") {
      const at = value as DesignTweakPoint;
      (raw.x as Record<string, unknown>).default = at.x;
      (raw.y as Record<string, unknown>).default = at.y;
    } else {
      raw.default = value;
    }
    for (const name of differing) {
      if (VAR.test(name)) vars[name] = formatted[name]!;
      else attrs[name] = formatted[name]!;
    }
    if (control.type === "text") {
      textChanges.push({ target: tweakTargetName(control.target), before: control.default, after: String(value) });
    }
  }
  if (!changed) return { ok: false, reason: "unchanged" };
  const declaration = `\n${JSON.stringify(json, null, 2)}\n`;
  const start = match.index + match[0].indexOf(match[1]!, match[0].indexOf(">"));
  let next = source.slice(0, start) + declaration + source.slice(start + match[1]!.length);
  if (Object.keys(vars).length > 0) next = withTweakStyle(next, vars);
  if (Object.keys(attrs).length > 0) {
    const html = HTML_TAG.exec(next);
    if (html) {
      let tag = html[0];
      for (const [name, value] of Object.entries(attrs)) tag = withAttribute(tag, name, value);
      next = next.slice(0, html.index) + tag + next.slice(html.index + html[0].length);
    } else {
      next = `<html ${Object.entries(attrs)
        .map(([name, value]) => `${name}="${value}"`)
        .join(" ")}>\n${next}`;
    }
  }
  return { ok: true, source: next, kept: [], textChanges };
}

// ---- Shuffle and hand-off --------------------------------------------------

function randomStep(numbers: { min: number; max: number; step: number }, random: () => number): number {
  const steps = Math.floor((numbers.max - numbers.min) / numbers.step + 1e-9);
  return Number((numbers.min + Math.floor(random() * (steps + 1)) * numbers.step).toFixed(4));
}

function randomColor(random: () => number): string {
  // Hue anywhere, with enough colour and contrast to read as a choice.
  const hue = random() * 360;
  const saturation = 0.55 + random() * 0.3;
  const lightness = 0.4 + random() * 0.15;
  const channel = (n: number) => {
    const k = (n + hue / 30) % 12;
    const a = saturation * Math.min(lightness, 1 - lightness);
    const c = lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

/**
 * Random values for every switch, choice, number, colour and pad, each inside
 * its own limits and on its own steps. Words and actions are left as they are.
 */
export function shuffleDesignTweaks(
  controls: readonly DesignTweakControl[],
  values: DesignTweakValues | undefined,
  random: () => number = Math.random,
): DesignTweakValues | undefined {
  let next = values;
  for (const control of controls) {
    switch (control.type) {
      case "switch":
        next = withDesignTweak(next, control, random() < 0.5);
        break;
      case "choice":
        next = withDesignTweak(next, control, control.options[Math.min(control.options.length - 1, Math.floor(random() * control.options.length))]!);
        break;
      case "number":
        next = withDesignTweak(next, control, randomStep(control, random));
        break;
      case "color":
        next = withDesignTweak(next, control, randomColor(random));
        break;
      case "pad":
        next = withDesignTweak(next, control, { x: randomStep(control.x, random), y: randomStep(control.y, random) });
        break;
      case "text":
      case "action":
        break;
    }
  }
  return next;
}

/** How a value reads to a person: "16px", "on", "#2f6fed", "Distance 8px, Blur 24px". */
export function describeDesignTweak(control: DesignTweakControl, value: DesignTweakValue): string {
  switch (control.type) {
    case "action":
      return "";
    case "switch":
      return value ? "on" : "off";
    case "number":
      return `${Number(Number(value).toFixed(4))}${control.unit}`;
    case "pad": {
      const at = value as DesignTweakPoint;
      return `${control.x.label} ${Number(at.x.toFixed(4))}${control.x.unit}, ${control.y.label} ${Number(at.y.toFixed(4))}${control.y.unit}`;
    }
    default:
      return String(value);
  }
}

/**
 * The note that hands a frame's values to Aiden, or copies them: one line per
 * control, marking the ones the person changed.
 */
export function designTweakSummary(
  controls: readonly DesignTweakControl[],
  values: DesignTweakValues | undefined,
  options: { dark?: boolean; version?: string } = {},
): string {
  const lines: string[] = [];
  for (const control of controls) {
    if (control.type === "action") continue;
    const value = readDesignTweak(control, values);
    const changed = withDesignTweak(undefined, control, value) !== undefined;
    lines.push(`- ${control.group ? `${control.group} / ` : ""}${control.label}: ${describeDesignTweak(control, value)}${changed ? " (changed)" : ""}`);
  }
  if (options.dark) lines.push("- Dark: on");
  const heading = options.version ? `Tweaks values (${options.version}):` : "Tweaks values:";
  return [heading, ...lines].join("\n");
}

// ---- Versions --------------------------------------------------------------

/** A saved set of a frame's values, with the Dark switch, that the person can come back to. */
export type DesignTweakVersion = { id: string; name: string; tweaks?: DesignTweakValues; dark?: true };

export const DESIGN_TWEAK_VERSION_LIMITS = { versions: 12, nameChars: 40 } as const;

/** Reads a frame's stored versions: bounded, with safe values, ids unique; undefined when none are left. */
export function parseDesignTweakVersions(value: unknown): DesignTweakVersion[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const versions: DesignTweakVersion[] = [];
  const ids = new Set<string>();
  for (const raw of value) {
    if (versions.length >= DESIGN_TWEAK_VERSION_LIMITS.versions) break;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const id = typeof entry.id === "string" && ID.test(entry.id) ? entry.id : null;
    const name = text(entry.name, DESIGN_TWEAK_VERSION_LIMITS.nameChars);
    if (!id || !name || ids.has(id)) continue;
    ids.add(id);
    const tweaks = parseDesignTweakValues(entry.tweaks);
    versions.push({ id, name, ...(tweaks ? { tweaks } : {}), ...(entry.dark === true ? { dark: true as const } : {}) });
  }
  return versions.length > 0 ? versions : undefined;
}

function sameValues(a: DesignTweakValues | undefined, b: DesignTweakValues | undefined): boolean {
  const left = Object.entries(a ?? {});
  if (left.length !== Object.keys(b ?? {}).length) return false;
  return left.every(([name, value]) => b?.[name] === value);
}

/** Whether a frame now shows a version: the same values and the same Dark switch. */
export function showsDesignTweakVersion(
  frame: { tweaks?: DesignTweakValues; dark?: true },
  version: { tweaks?: DesignTweakValues; dark?: true },
): boolean {
  return sameValues(frame.tweaks, version.tweaks) && (frame.dark === true) === (version.dark === true);
}

/** The next free "V<n>" name; V1 is always the page as its file says. */
export function nextDesignTweakVersionName(versions: readonly DesignTweakVersion[] | undefined): string {
  const used = new Set((versions ?? []).map((version) => version.name));
  for (let n = 2; ; n += 1) if (!used.has(`V${n}`)) return `V${n}`;
}
