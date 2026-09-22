export interface AidenRemoteRevocationState {
  revokeDevice(deviceId: string): Promise<boolean>;
  snapshot(): Promise<{ devices: Array<{ id: string; revokedAt?: number }> }>;
}

export interface AidenRemoteRevocationResources {
  state: AidenRemoteRevocationState;
  streams?: { revokeDevice(deviceId: string): Promise<void> };
  chats?: { revokeDevice(deviceId: string): void };
  workspaceOwners: { revokeDevice(deviceId: string): void };
}

/**
 * Main-process revocation transaction. Device state is committed first so a
 * crash can never revive the credential. Cleanup is then retried even for an
 * already-revoked device, and stream-journal durability is part of success.
 */
export async function revokeAidenRemoteRuntimeDevice(
  resources: AidenRemoteRevocationResources,
  deviceId: string,
): Promise<boolean> {
  const newlyRevoked = await resources.state.revokeDevice(deviceId);
  const device = (await resources.state.snapshot()).devices.find(({ id }) => id === deviceId);
  if (device?.revokedAt === undefined) return false;

  resources.chats?.revokeDevice(deviceId);
  resources.workspaceOwners.revokeDevice(deviceId);
  await resources.streams?.revokeDevice(deviceId);
  return newlyRevoked;
}
