/**
 * DESIGN.md section aliases, as the pinned linter's `spec-config.yaml`
 * declares them (`sections.test.ts` checks the two match). Aiden folds
 * aliases before counting duplicate sections, which 0.4.0 doesn't report.
 */
export const DESIGN_MD_SECTION_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "Brand & Style": "Overview",
  "Layout & Spacing": "Layout",
  Elevation: "Elevation & Depth",
});

export function canonicalSection(name: string): string {
  return Object.prototype.hasOwnProperty.call(DESIGN_MD_SECTION_ALIASES, name) ? DESIGN_MD_SECTION_ALIASES[name]! : name;
}
