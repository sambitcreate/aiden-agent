import type { RuntimeProfileId } from "../runtime-profile-core.js";

export const AIDEN_REMOTE_PRODUCTION_LAN_PORT = 49_220;
export const AIDEN_REMOTE_DEVELOPMENT_LAN_PORT = 50_220;
export const AIDEN_REMOTE_PORT_PAIR_CANDIDATE_COUNT = 64;

function lastLanPort(firstLanPort: number): number {
  return firstLanPort + (AIDEN_REMOTE_PORT_PAIR_CANDIDATE_COUNT - 1) * 2;
}

export function isAidenRemoteReservedLanPort(
  port: number,
  profile: RuntimeProfileId,
): boolean {
  const firstLanPort = aidenRemoteDefaultLanPort(profile);
  return Number.isInteger(port)
    && port >= firstLanPort
    && port <= lastLanPort(firstLanPort);
}

export function aidenRemoteDefaultLanPort(profile: RuntimeProfileId): number {
  return profile === "development"
    ? AIDEN_REMOTE_DEVELOPMENT_LAN_PORT
    : AIDEN_REMOTE_PRODUCTION_LAN_PORT;
}

export function aidenRemotePortCandidatesForRange(
  preferredPort: number,
  firstDynamicLanPort: number,
): number[] {
  const values: number[] = [];
  const add = (port: number) => {
    if (
      Number.isInteger(port)
      && port > 0
      && port < 65_535
      && port % 2 === 0
      && !values.includes(port)
    ) {
      values.push(port);
    }
  };
  add(preferredPort);
  for (
    let index = 0;
    index < AIDEN_REMOTE_PORT_PAIR_CANDIDATE_COUNT;
    index += 1
  ) {
    add(firstDynamicLanPort + index * 2);
  }
  return values.slice(0, AIDEN_REMOTE_PORT_PAIR_CANDIDATE_COUNT);
}

export function aidenRemotePortCandidatesForProfile(
  profile: RuntimeProfileId,
  preferredPort = aidenRemoteDefaultLanPort(profile),
): number[] {
  const otherProfile = profile === "development" ? "production" : "development";
  const safePreferredPort = isAidenRemoteReservedLanPort(preferredPort, otherProfile)
    ? aidenRemoteDefaultLanPort(profile)
    : preferredPort;
  return aidenRemotePortCandidatesForRange(
    safePreferredPort,
    aidenRemoteDefaultLanPort(profile),
  );
}
