/**
 * Proxy grants live for a minute. The stream only needs one when it connects,
 * but the accessibility overlay polls and the event log may open long after
 * the stream did, so they draw grants from here: the cached grant while it has
 * a few seconds left, otherwise a newly minted one. Minting is a local IPC to
 * main, never a network call.
 */
import type { DeviceStreamGrant } from "../shared/devices";

const RENEW_BEFORE_MS = 5_000;

export interface DeviceGrantSource {
  get(): Promise<DeviceStreamGrant>;
  /** Forgets the cached grant after the proxy refused it. */
  invalidate(): void;
}

export function createDeviceGrantSource(
  mint: () => Promise<DeviceStreamGrant>,
  now: () => number = Date.now,
): DeviceGrantSource {
  let cached: DeviceStreamGrant | null = null;
  let pending: Promise<DeviceStreamGrant> | null = null;
  return {
    get() {
      if (cached && cached.expiresAt - now() > RENEW_BEFORE_MS) return Promise.resolve(cached);
      pending ??= mint()
        .then((grant) => {
          cached = grant;
          return grant;
        })
        .finally(() => {
          pending = null;
        });
      return pending;
    },
    invalidate() {
      cached = null;
    },
  };
}
