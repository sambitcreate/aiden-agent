/**
 * `web_fetch` settings IPC: reading web pages, and extract mode with its
 * extraction model's account ID. Keys are managed through the Web Search
 * key-pool channels; nothing here accepts or returns key material.
 * Dependencies are injected so the channels can be registered and invoked in
 * tests without Electron.
 */

import {
  normalizeWebExtractAccountId,
  type WebFetchRendererSnapshot,
  type WebFetchSettingsV1,
} from "../../renderer/shared/web-fetch-settings.js";

export const WEB_FETCH_CHANNELS = Object.freeze([
  "webSearch:pages:get",
  "webSearch:pages:setEnabled",
  "webSearch:pages:setExtractEnabled",
  "webSearch:pages:setExtractAccountId",
] as const);

export interface WebFetchHandlerDependencies<Event> {
  readonly handle: (channel: string, handler: (event: Event, ...args: unknown[]) => unknown) => void;
  /** Returns a liveness check for the sender document; throws for a foreign sender. */
  readonly owner: (event: Event) => { isDestroyed(): boolean };
  readonly snapshot: () => Promise<WebFetchRendererSnapshot>;
  readonly update: (
    mutation: (current: WebFetchSettingsV1) => WebFetchSettingsV1,
    isCurrent: () => boolean,
  ) => Promise<unknown>;
}

const INACTIVE = "The renderer document is no longer active.";

export function registerWebFetchHandlers<Event>(dependencies: WebFetchHandlerDependencies<Event>): void {
  const live = (event: Event) => {
    const owner = dependencies.owner(event);
    if (owner.isDestroyed()) throw new Error(INACTIVE);
    return owner;
  };
  const snapshotFor = async (owner: { isDestroyed(): boolean }) => {
    const snapshot = await dependencies.snapshot();
    if (owner.isDestroyed()) throw new Error(INACTIVE);
    return snapshot;
  };
  const change = async (
    event: Event,
    mutation: (current: WebFetchSettingsV1) => WebFetchSettingsV1,
  ) => {
    const owner = live(event);
    await dependencies.update(mutation, () => !owner.isDestroyed());
    return snapshotFor(owner);
  };

  dependencies.handle("webSearch:pages:get", (event) => snapshotFor(live(event)));

  dependencies.handle("webSearch:pages:setEnabled", (event, enabled) => {
    if (typeof enabled !== "boolean") throw new Error("Reading web pages must be on or off.");
    return change(event, (current) => ({ ...current, enabled }));
  });

  dependencies.handle("webSearch:pages:setExtractEnabled", async (event, enabled) => {
    if (typeof enabled !== "boolean") throw new Error("Extract mode must be on or off.");
    live(event);
    // Turning it on needs a working model; turning it off never does.
    if (enabled && !(await dependencies.snapshot()).extract.ready) {
      throw new Error("Add the Cloudflare account ID and at least one API key before turning on extract mode.");
    }
    return change(event, (current) => ({ ...current, extract: { ...current.extract, enabled } }));
  });

  dependencies.handle("webSearch:pages:setExtractAccountId", (event, value) => {
    if (value !== null && typeof value !== "string") throw new Error("The account ID must be text.");
    const trimmed = typeof value === "string" ? value.trim() : "";
    const accountId = trimmed ? normalizeWebExtractAccountId(trimmed) : undefined;
    if (trimmed && accountId === undefined) {
      throw new Error("A Cloudflare account ID is 32 letters and digits (0-9, a-f).");
    }
    return change(event, (current) => {
      const { accountId: _previous, ...extract } = current.extract;
      return { ...current, extract: accountId === undefined ? extract : { ...extract, accountId } };
    });
  });
}
