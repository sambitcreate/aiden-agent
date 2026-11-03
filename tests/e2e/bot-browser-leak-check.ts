/**
 * The secrets found in what a snapshot shows: its strings, without Chromium's
 * node ids and the element refs. Those are counters, so a short code such as a
 * card's "737" can turn up in one by chance (node 4737).
 */
const NODE_ID_KEYS = new Set(["nodeId", "parentId", "childIds", "ref"]);
export function leakedIn(secrets: readonly string[], ...parts: unknown[]): string[] {
  const strings = (value: unknown): string[] =>
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.flatMap(strings)
        : value && typeof value === "object"
          ? Object.entries(value).flatMap(([key, item]) => (NODE_ID_KEYS.has(key) ? [] : strings(item)))
          : [];
  const shown = strings(parts);
  return secrets.filter((secret) => shown.some((text) => text.includes(secret)));
}

type AxNode = {
  role?: { value?: string };
  properties?: { name: string; value: { value?: unknown } }[];
};

/** The document URL includes the loopback port assigned to this run. */
export function tableLeaks(
  secrets: readonly string[],
  table: { text: string; elements: readonly unknown[]; accessibilityTree?: unknown },
  origin: string,
): string[] {
  const tree = structuredClone(table.accessibilityTree) as { nodes?: AxNode[] } | undefined;
  for (const node of tree?.nodes ?? []) {
    if (node.role?.value !== "RootWebArea") continue;
    for (const property of node.properties ?? []) {
      const url = property.value?.value;
      if (property.name !== "url" || typeof url !== "string" || !url.startsWith(origin)) continue;
      const suffix = url.slice(origin.length);
      if (/^(?:[/?#]|$)/u.test(suffix)) property.value.value = suffix;
    }
  }
  return leakedIn(secrets, table.text, table.elements, tree);
}
