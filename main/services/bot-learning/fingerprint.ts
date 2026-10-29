// A full SHA-256 over what shapes a Bot's behavior (spec §4.4), recorded on
// every learning change so a review can tell when the setup changed.

import { createHash } from "node:crypto";

export interface BotFingerprintInputs {
  botRevision: string;
  memoryRevision: string;
  lessonsRevision: string;
  skills: ReadonlyArray<{ name: string; contentFingerprint: string }>;
  appVersion: string;
}

export function botBehaviorFingerprint(inputs: BotFingerprintInputs): string {
  const canonical = JSON.stringify({
    botRevision: inputs.botRevision,
    memoryRevision: inputs.memoryRevision,
    lessonsRevision: inputs.lessonsRevision,
    skills: [...inputs.skills].map(({ name, contentFingerprint }) => [name, contentFingerprint]).sort(),
    appVersion: inputs.appVersion,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
