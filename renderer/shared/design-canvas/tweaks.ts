// Tweaks: a page's own simple controls, and the Dark switch.
//
// A page declares its controls in one JSON block:
//
//   <script type="application/aiden-tweaks">
//   { "controls": [
//     { "id": "accent", "label": "Accent", "type": "color", "default": "#2f6fed", "var": "--accent" },
//     { "id": "density", "label": "Density", "type": "choice", "options": ["compact", "cozy"],
//       "default": "cozy", "attr": "data-density" },
//     { "id": "radius", "label": "Corners", "type": "number", "min": 0, "max": 24, "step": 2,
//       "unit": "px", "default": 8, "var": "--radius" },
//     { "id": "promo", "label": "Promo banner", "type": "switch", "default": true, "attr": "data-promo" }
//   ] }
//   </script>
//
// Each control sets one CSS variable or one `data-*` attribute on the page's
// root element. The frame keeps only the values the person changed, keyed by
// that target (`tweaks`), so the bridge can apply them without the
// declaration, and an export draws the same page. Nothing is written to the
// page's file. Pure, so it is tested without a DOM.

export type DesignTweakTarget = { var: string } | { attr: string };

export type DesignTweakControl = { id: string; label: string; target: DesignTweakTarget } & (
  | { type: "switch"; default: boolean }
  | { type: "choice"; options: string[]; default: string }
  | { type: "number"; min: number; max: number; step: number; unit: string; default: number }
  | { type: "color"; default: string }
);

/** A frame's changed values: target name (`--x` or `data-x`) to the text the page gets. */
export type DesignTweakValues = Record<string, string>;

export const DESIGN_TWEAK_LIMITS = {
  controls: 24,
  labelChars: 60,
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

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, max) : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000 ? value : null;
}

function control(raw: unknown): DesignTweakControl | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const id = typeof entry.id === "string" && ID.test(entry.id) ? entry.id : null;
  if (!id) return null;
  let target: DesignTweakTarget | null = null;
  if (typeof entry.var === "string" && VAR.test(entry.var)) target = { var: entry.var };
  else if (typeof entry.attr === "string" && ATTR.test(entry.attr)) target = { attr: entry.attr };
  if (!target) return null;
  const label = text(entry.label, DESIGN_TWEAK_LIMITS.labelChars) ?? id;
  if (entry.type === "switch") {
    return { id, label, target, type: "switch", default: entry.default === true };
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
    return { id, label, target, type: "choice", options, default: fallback };
  }
  if (entry.type === "number") {
    const min = number(entry.min) ?? 0;
    const max = number(entry.max) ?? 100;
    if (max <= min) return null;
    const step = number(entry.step);
    const unit = typeof entry.unit === "string" && UNIT.test(entry.unit) ? entry.unit : "";
    const fallback = number(entry.default);
    return {
      id,
      label,
      target,
      type: "number",
      min,
      max,
      step: step !== null && step > 0 ? step : 1,
      unit,
      default: fallback === null ? min : Math.min(max, Math.max(min, fallback)),
    };
  }
  if (entry.type === "color") {
    const fallback = typeof entry.default === "string" && HEX.test(entry.default) ? entry.default.toLowerCase() : "#000000";
    return { id, label, target, type: "color", default: fallback };
  }
  return null;
}

/** Reads a declaration's JSON: `{ "controls": [...] }` or a bare array. Two controls never share an id or a target. */
export function parseDesignTweakControls(value: unknown): DesignTweakControl[] {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { controls?: unknown }).controls)
      ? (value as { controls: unknown[] }).controls
      : [];
  const ids = new Set<string>();
  const targets = new Set<string>();
  const controls: DesignTweakControl[] = [];
  for (const raw of list) {
    if (controls.length >= DESIGN_TWEAK_LIMITS.controls) break;
    const found = control(raw);
    if (!found || ids.has(found.id) || targets.has(tweakTargetName(found.target))) continue;
    ids.add(found.id);
    targets.add(tweakTargetName(found.target));
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

/** The text a control's value puts on the page. */
export function formatDesignTweak(control: DesignTweakControl, value: boolean | string | number): string {
  switch (control.type) {
    case "switch":
      // A variable gets 1 or 0, for `calc()`; an attribute gets "true" or "false", for selectors.
      return "var" in control.target ? (value ? "1" : "0") : value ? "true" : "false";
    case "number": {
      const raw = typeof value === "number" ? value : Number(value);
      const clamped = Math.min(control.max, Math.max(control.min, Number.isFinite(raw) ? raw : control.default));
      return `${Number(clamped.toFixed(4))}${"var" in control.target ? control.unit : ""}`;
    }
    case "choice":
      return typeof value === "string" && control.options.includes(value) ? value : control.default;
    case "color":
      return typeof value === "string" && HEX.test(value) ? value.toLowerCase() : control.default;
  }
}

/** What the panel shows for a control: the frame's value read back, or the page's default. */
export function readDesignTweak(control: DesignTweakControl, values: DesignTweakValues | undefined): boolean | string | number {
  const stored = values?.[tweakTargetName(control.target)];
  if (stored === undefined) return control.default;
  switch (control.type) {
    case "switch":
      return stored === "1" || stored === "true";
    case "number": {
      const parsed = Number.parseFloat(stored);
      return Number.isFinite(parsed) ? Math.min(control.max, Math.max(control.min, parsed)) : control.default;
    }
    case "choice":
      return control.options.includes(stored) ? stored : control.default;
    case "color":
      return HEX.test(stored) ? stored.toLowerCase() : control.default;
  }
}

/**
 * The frame's values after one control changes. A value equal to the page's
 * default is dropped, so Reset and "back to the default" both leave the page
 * as its file says. Undefined when nothing is left.
 */
export function withDesignTweak(
  values: DesignTweakValues | undefined,
  control: DesignTweakControl,
  value: boolean | string | number,
): DesignTweakValues | undefined {
  const name = tweakTargetName(control.target);
  const next: DesignTweakValues = { ...values };
  const formatted = formatDesignTweak(control, value);
  if (formatted === formatDesignTweak(control, control.default)) delete next[name];
  else next[name] = formatted;
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
