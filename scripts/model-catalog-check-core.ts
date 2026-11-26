// The release model check: compare each built-in provider's model list as
// bundled in Aiden (the pinned Pi catalog) with the live list Aiden reads at
// runtime from pi.dev, and say plainly what is missing. It only warns; a
// release never waits on it. A model missing from the bundle still reaches
// people through the live list, but only after a refresh, and some need a
// newer Pi to run at all, so the fix is a Pi upgrade.

export type LiveCatalog =
  | { kind: "models"; ids: readonly string[] }
  /** pi.dev serves no list for this provider (404/501). */
  | { kind: "none" }
  /** The live list asks for a newer Pi than Aiden pins. */
  | { kind: "needs-pi"; version: string }
  | { kind: "error"; message: string };

export interface ProviderCatalogCheck {
  providerId: string;
  /** Live on pi.dev but not in Aiden's bundled list. */
  missing: string[];
  /** In Aiden's bundled list but gone from pi.dev. */
  retired: string[];
  needsPi?: string;
  error?: string;
}

export function checkProviderCatalog(
  providerId: string,
  bundledIds: readonly string[],
  live: LiveCatalog,
): ProviderCatalogCheck {
  if (live.kind === "none") return { providerId, missing: [], retired: [] };
  if (live.kind === "needs-pi") return { providerId, missing: [], retired: [], needsPi: live.version };
  if (live.kind === "error") return { providerId, missing: [], retired: [], error: live.message };
  const bundled = new Set(bundledIds);
  const liveIds = new Set(live.ids);
  const sorted = (ids: Iterable<string>) => [...ids].sort((a, b) => a.localeCompare(b));
  return {
    providerId,
    missing: sorted([...liveIds].filter((id) => !bundled.has(id))),
    retired: sorted([...bundled].filter((id) => !liveIds.has(id))),
  };
}

export interface CatalogCheckReport {
  /** Whether Aiden's bundled lists are behind for any provider. */
  outdated: boolean;
  markdown: string;
  /** One line per provider that needs attention, for CI warning annotations. */
  warnings: string[];
}

const LIST_LIMIT = 12;

function listIds(ids: readonly string[]): string {
  const shown = ids.slice(0, LIST_LIMIT).map((id) => `\`${id}\``).join(", ");
  return ids.length > LIST_LIMIT ? `${shown} and ${ids.length - LIST_LIMIT} more` : shown;
}

export function formatCatalogReport(
  checks: readonly ProviderCatalogCheck[],
  piVersion: string,
): CatalogCheckReport {
  const behind = checks.filter((check) => check.missing.length > 0 || check.needsPi);
  const retired = checks.filter((check) => check.retired.length > 0);
  const failed = checks.filter((check) => check.error);
  const warnings = behind.map((check) =>
    check.needsPi
      ? `${check.providerId}: the live model list needs Pi ${check.needsPi} (Aiden pins ${piVersion}).`
      : `${check.providerId}: ${check.missing.length} model${check.missing.length === 1 ? "" : "s"} missing from Aiden's built-in list: ${check.missing.join(", ")}`,
  );
  const lines = ["## Model catalog check", ""];
  if (behind.length === 0) {
    lines.push(`Aiden's built-in model lists (Pi ${piVersion}) include every model pi.dev lists for ${checks.length - failed.length} providers.`);
  } else {
    lines.push(
      `Aiden's built-in model lists (Pi ${piVersion}) are behind for ${behind.length} provider${behind.length === 1 ? "" : "s"}. ` +
        "People still get these models from the live list once Aiden refreshes it, but upgrading Pi brings them in from the first launch.",
      "",
      "| Provider | Missing from Aiden |",
      "|---|---|",
      ...behind.map((check) =>
        `| ${check.providerId} | ${check.needsPi ? `Live list needs Pi ${check.needsPi}` : listIds(check.missing)} |`,
      ),
    );
  }
  if (retired.length > 0) {
    const count = retired.reduce((total, check) => total + check.retired.length, 0);
    lines.push(
      "",
      "<details>",
      `<summary>${count} built-in model${count === 1 ? " is" : "s are"} gone from pi.dev (chats that use them keep working)</summary>`,
      "",
      ...retired.map((check) => `- ${check.providerId}: ${listIds(check.retired)}`),
      "",
      "</details>",
    );
  }
  if (failed.length > 0) {
    lines.push("", `Couldn't check: ${failed.map((check) => `${check.providerId} (${check.error})`).join(", ")}.`);
  }
  return { outdated: behind.length > 0, markdown: `${lines.join("\n")}\n`, warnings };
}
