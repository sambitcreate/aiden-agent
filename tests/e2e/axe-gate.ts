import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

/** WCAG 2.0, 2.1 and 2.2 level A and AA rules. Best-practice rules are not part of the gate. */
export const AXE_WCAG_TAGS = Object.freeze([
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22a",
  "wcag22aa",
]);

/**
 * A known violation the gate tolerates for now. `target` is the node's axe
 * selector (frames joined with " >> "), matched exactly or by pattern.
 * Every entry must still match a violation on its surface: once the cause is
 * fixed the audit fails until the entry is deleted, so this list only shrinks.
 */
export type AxeExclusion = {
  surface: string;
  rule: string;
  target: string | RegExp;
  reason: string;
};

export const AXE_EXCLUSIONS: readonly AxeExclusion[] = Object.freeze([
  {
    surface: "chat window",
    rule: "label-content-name-mismatch",
    target: ".composer-workspace-trigger",
    reason:
      'The composer\'s workspace chip shows the workspace name but is named "Choose a workspace" (WCAG 2.5.3). ' +
      "Fix in renderer/components/composer.tsx, which another unit is editing, by putting the visible name first in the aria-label.",
  },
  {
    surface: "model picker",
    rule: "nested-interactive",
    target: /^#radix-_r_[0-9a-z]+_$/u,
    reason:
      "Model picker list rows nest the Pin and Add to Pad buttons inside the cmdk option. " +
      "Moving them out of the option is a row restructure in renderer/components/model-picker.tsx, which another unit is editing.",
  },
]);

export type AxeAuditOptions = {
  /** Names the surface for exclusions and failure messages. */
  surface: string;
  /** CSS selector of the root to audit; the whole window when omitted. */
  include?: string;
  exclusions?: readonly AxeExclusion[];
};

type AxeNode = { target: unknown[]; failureSummary?: string };
type AxeViolation = {
  id: string;
  impact?: string | null;
  help: string;
  helpUrl: string;
  nodes: AxeNode[];
};

function nodeTarget(node: AxeNode): string {
  return node.target
    .map((part) => (Array.isArray(part) ? part.join(" >> ") : String(part)))
    .join(" >> ");
}

function matches(
  exclusion: AxeExclusion,
  rule: string,
  target: string,
): boolean {
  if (exclusion.rule !== rule) return false;
  return typeof exclusion.target === "string"
    ? exclusion.target === target
    : target.search(exclusion.target) !== -1; // search() ignores lastIndex, so /g is safe
}

/**
 * Applies the exclusion list to axe violations for one surface. Returns one
 * readable line per unexcused node, then one per exclusion that matched nothing.
 */
export function axeProblems(
  surface: string,
  violations: readonly AxeViolation[],
  exclusions: readonly AxeExclusion[] = AXE_EXCLUSIONS,
): string[] {
  const own = exclusions.filter((exclusion) => exclusion.surface === surface);
  const used = new Set<AxeExclusion>();
  const problems: string[] = [];
  for (const violation of violations) {
    for (const node of violation.nodes) {
      const target = nodeTarget(node);
      const exclusion = own.find((candidate) =>
        matches(candidate, violation.id, target),
      );
      if (exclusion) {
        used.add(exclusion);
        continue;
      }
      const summary = node.failureSummary?.replace(/\s+/gu, " ").trim();
      problems.push(
        `[${surface}] ${violation.id} (${violation.impact ?? "unknown"}) at ${target}: ${violation.help}` +
          `${summary ? ` | ${summary}` : ""} | ${violation.helpUrl}`,
      );
    }
  }
  for (const exclusion of own) {
    if (!used.has(exclusion)) {
      problems.push(
        `[${surface}] stale exclusion: ${exclusion.rule} at ${String(exclusion.target)} no longer fails; delete it from AXE_EXCLUSIONS`,
      );
    }
  }
  return problems;
}

/**
 * Runs axe with the WCAG A/AA tags on a surface and returns its problems
 * (empty when clean). Legacy mode runs axe inside the Electron page itself;
 * the default mode needs a second blank page, which Electron cannot open.
 */
export async function auditAccessibility(
  page: Page,
  options: AxeAuditOptions,
): Promise<string[]> {
  let builder = new AxeBuilder({ page })
    .withTags([...AXE_WCAG_TAGS])
    .setLegacyMode(true);
  if (options.include) builder = builder.include(options.include);
  const results = await builder.analyze();
  return axeProblems(
    options.surface,
    results.violations as AxeViolation[],
    options.exclusions,
  );
}
