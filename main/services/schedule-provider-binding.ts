import { createHash } from "node:crypto";
import type { StoredProvider } from "./types.js";

export const SCHEDULED_PROVIDER_FINGERPRINT = /^[a-f0-9]{64}$/u;

/** Bind an approval to the connection properties that choose the inference recipient. */
export function scheduledProviderFingerprint(
  provider: Pick<
    StoredProvider,
    "id" | "kind" | "label" | "baseUrl" | "needsKey" | "deployment" | "isBuiltin"
  >,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: provider.id,
        kind: provider.kind,
        label: provider.label,
        baseUrl: provider.baseUrl,
        needsKey: provider.needsKey,
        deployment: provider.deployment ?? null,
        isBuiltin: provider.isBuiltin === true,
      }),
    )
    .digest("hex");
}

export function assertScheduledProviderFingerprint(
  provider: StoredProvider,
  expected: string | undefined,
): void {
  if (!expected || scheduledProviderFingerprint(provider) !== expected) {
    throw new Error(
      "The approved provider connection changed after this automation was confirmed. Review and approve its provider and model again.",
    );
  }
}
