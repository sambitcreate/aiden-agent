/**
 * A starter DESIGN.md from a token snapshot (spec §6.9, R8, S37).
 *
 * The snapshot comes from the app's own style files through v1's scanner;
 * Phase 5 adds the bridge's token collection as a second source. The front
 * matter is written with the `yaml` package, never by concatenation, so a
 * value from a style file can't add keys or close the block. Token groups
 * with no evidence go under `omitted`; 0.4.0 accepts only token-group names
 * there (colors, typography, rounded, spacing, components), so prose sections
 * without evidence are left out rather than listed.
 */
import path from "node:path";
import { stringify } from "yaml";
import { isSafeWorkspaceRelativePath } from "../canvas-config.js";
import { findWorkspaceDesignSystem } from "./style-scan.js";

export const DESIGN_MD_DRAFT_MAX_BYTES = 32 * 1024;
const NO_EVIDENCE = "No evidence in the app's styles yet.";

export type DesignTokenSnapshot = {
  name?: string;
  colors: { name: string | null; value: string; dark?: string }[];
  fonts: { name: string | null; family: string }[];
  rounded?: { name: string; value: string }[];
  spacing?: { name: string; value: string }[];
};

/** `--Primary`, `$primary` and `Brand Blue!` become `primary` and `brand-blue`; empty gives "". */
function tokenName(raw: string | null): string {
  return (raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

/** Unique names in order: repeats get `-2`, `-3`; nameless ones get `<fallback>-1`, `-2`… */
function uniqueNames(raw: Array<string | null>, fallback: string, strip?: RegExp): string[] {
  const used = new Set<string>();
  let nameless = 0;
  return raw.map((value) => {
    let base = tokenName(value);
    if (strip && base.replace(strip, "")) base = base.replace(strip, "");
    if (!base) {
      do base = `${fallback}-${++nameless}`;
      while (used.has(base));
    }
    let name = base;
    for (let suffix = 2; used.has(name); suffix++) name = `${base}-${suffix}`;
    used.add(name);
    return name;
  });
}

const SECTIONS: ReadonlyArray<{ heading: string; placeholder: string; evidence: (snapshot: DesignTokenSnapshot) => boolean }> = [
  { heading: "Overview", placeholder: "Drafted from the app's own styles. Describe the product's look and feel here.", evidence: () => true },
  { heading: "Colors", placeholder: "Describe when to use each colour.", evidence: (s) => s.colors.length > 0 },
  { heading: "Typography", placeholder: "Describe what each typeface is for.", evidence: (s) => s.fonts.length > 0 },
  { heading: "Layout", placeholder: "Describe the spacing scale and grid.", evidence: (s) => (s.spacing?.length ?? 0) > 0 },
  { heading: "Elevation & Depth", placeholder: "", evidence: () => false },
  { heading: "Shapes", placeholder: "Describe the corner radii.", evidence: (s) => (s.rounded?.length ?? 0) > 0 },
  { heading: "Components", placeholder: "", evidence: () => false },
  { heading: "Do's and Don'ts", placeholder: "", evidence: () => false },
];

function render(snapshot: DesignTokenSnapshot): string {
  const front: Record<string, unknown> = { name: snapshot.name ?? "Design system" };
  if (snapshot.colors.length > 0) {
    const names = uniqueNames(snapshot.colors.map((color) => color.name), "color");
    const colors: Record<string, unknown> = {};
    const dark: Record<string, string> = {};
    snapshot.colors.forEach((color, index) => {
      colors[names[index]!] = color.value;
      if (color.dark !== undefined) dark[names[index]!] = color.dark;
    });
    // A light token that happens to be named `dark` gives way to the dark group.
    if (Object.keys(dark).length > 0) colors.dark = dark;
    front.colors = colors;
  }
  if (snapshot.fonts.length > 0) {
    const names = uniqueNames(snapshot.fonts.map((font) => font.name), "font", /^font-/u);
    front.typography = Object.fromEntries(snapshot.fonts.map((font, index) => [names[index]!, { fontFamily: font.family }]));
  }
  for (const group of ["rounded", "spacing"] as const) {
    const entries = snapshot[group] ?? [];
    if (entries.length === 0) continue;
    const names = uniqueNames(entries.map((entry) => entry.name), group);
    front[group] = Object.fromEntries(entries.map((entry, index) => [names[index]!, entry.value]));
  }
  const omitted = (["colors", "typography", "rounded", "spacing", "components"] as const)
    .filter((group) => !(group in front))
    .map((section) => ({ section, reason: NO_EVIDENCE }));
  if (omitted.length > 0) front.omitted = omitted;

  const yaml = stringify(front, { blockQuote: false, lineWidth: 0 });
  const body = SECTIONS.filter((section) => section.evidence(snapshot))
    .map((section) => `## ${section.heading}\n\n${section.placeholder}\n`)
    .join("\n");
  return `---\n${yaml}---\n\n${body}`;
}

/** R8: a starter DESIGN.md, at most 32 KiB (colours are dropped from the end to fit). Pure. */
export function draftDesignMd(snapshot: DesignTokenSnapshot): string {
  let colors = snapshot.colors;
  let draft = render(snapshot);
  while (Buffer.byteLength(draft) > DESIGN_MD_DRAFT_MAX_BYTES && colors.length > 0) {
    // Halve the overshoot's share at a time, then settle one by one.
    const over = Buffer.byteLength(draft) - DESIGN_MD_DRAFT_MAX_BYTES;
    const perColor = Math.max(1, Math.floor(Buffer.byteLength(draft) / Math.max(1, colors.length)));
    const drop = Math.max(1, Math.floor(over / perColor / 2));
    colors = colors.slice(0, Math.max(0, colors.length - drop));
    draft = render({ ...snapshot, colors });
  }
  return draft;
}

/** The draft for `appRoot`, from the style files inside that app root only. */
export async function designMdDraftFor(workspaceRoot: string, appRoot: string, signal?: AbortSignal): Promise<string> {
  if (!isSafeWorkspaceRelativePath(appRoot)) throw new Error("The app root isn't a safe workspace path.");
  const folder = appRoot === "." ? path.resolve(workspaceRoot) : path.join(path.resolve(workspaceRoot), ...appRoot.split("/"));
  const detected = await findWorkspaceDesignSystem(folder, signal);
  return draftDesignMd({
    colors: detected.colors.map((color) => ({ name: color.name, value: color.value, ...(color.dark ? { dark: color.dark } : {}) })),
    fonts: detected.fonts.map((font) => ({ name: font.name, family: font.family })),
  });
}
