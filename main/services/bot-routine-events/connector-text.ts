// Watch DTO lengths count UTF-16 units, while native JSON decoders require
// complete surrogate pairs. Metadata may be repaired; saved instructions may not.
const UNPAIRED = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function connectorTextIsWellFormed(value: string): boolean {
  return !new RegExp(UNPAIRED.source).test(value);
}

export function boundedConnectorText(value: string, maximum: number): string {
  const bounded = value.replace(UNPAIRED, "\uFFFD").slice(0, maximum);
  const last = bounded.charCodeAt(bounded.length - 1);
  return last >= 0xD800 && last <= 0xDBFF ? bounded.slice(0, -1) : bounded;
}

export function connectorSourceLabels(labels: { providerLabel: string; accountLabel: string; resourceLabel: string }) {
  return { providerLabel: boundedConnectorText(labels.providerLabel.trim(), 500) || "Mail", accountLabel: boundedConnectorText(labels.accountLabel.trim(), 500) || "Selected Mail account", resourceLabel: boundedConnectorText(labels.resourceLabel.trim(), 500) || "Mail mailbox" };
}
