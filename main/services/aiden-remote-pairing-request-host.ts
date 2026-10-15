// Host-side glue for desktop connection requests: the device-local
// "Accept connection requests" setting and the system notification that tells
// the person a request is waiting for them.
//
// The setting deliberately lives in its own file rather than the strict
// aiden-remote-v1.json state document. That document's exact-key validation
// would make an older build reject the whole Remote state after a downgrade.

import { DataStore } from "./data-store.js";
import type { AidenPairingRequestPrompt } from "./aiden-remote-pairing-requests.js";

export const PAIRING_REQUEST_SETTINGS_FILE = "aiden-remote-pairing-requests-v1.json";
const MAX_SETTINGS_BYTES = 4 * 1_024;

export interface AidenPairingRequestSettingsDocument {
  version: 1;
  acceptPairingRequests: boolean;
}

function isSettingsDocument(value: unknown): value is AidenPairingRequestSettingsDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return keys.length === 2
    && keys[0] === "acceptPairingRequests"
    && keys[1] === "version"
    && record.version === 1
    && typeof record.acceptPairingRequests === "boolean";
}

export interface AidenPairingRequestSettingsStore {
  load(): Promise<boolean>;
  save(accept: boolean): Promise<void>;
}

/**
 * A missing file is the first-run default: requests are accepted. A file that
 * exists but is unreadable, malformed or from a future version fails closed,
 * so a damaged "off" never silently turns back on.
 */
export function createAidenPairingRequestSettingsStore(
  directory: () => string,
): AidenPairingRequestSettingsStore {
  const store = new DataStore<AidenPairingRequestSettingsDocument>(
    PAIRING_REQUEST_SETTINGS_FILE,
    { version: 1, acceptPairingRequests: true },
    directory,
    {
      maxBytes: MAX_SETTINGS_BYTES,
      fileMode: 0o600,
      preserveCorruptFile: true,
      normalize: (value) => isSettingsDocument(value)
        ? { version: 1, acceptPairingRequests: value.acceptPairingRequests }
        : { version: 1, acceptPairingRequests: false },
      isSafe: isSettingsDocument,
    },
  );
  return {
    load: async () => {
      const document = await store.load();
      if (await store.loadedFromCorruptFile()) return false;
      return document.acceptPairingRequests;
    },
    save: (accept) => store.save({ version: 1, acceptPairingRequests: accept }),
  };
}

interface PairingRequestNotification {
  on(event: "click", listener: () => void): unknown;
  show(): void;
}

export interface AidenPairingRequestNotifierDependencies {
  list(): AidenPairingRequestPrompt[];
  broadcast(): void;
  isSupported(): boolean;
  create(options: { title: string; body: string }): PairingRequestNotification;
  focusApp(): void;
  hostNoun: string;
  onError?(stage: "delivery" | "focus"): void;
}

/**
 * Returns the change callback for the request service. Every change refreshes
 * the renderer; a system notification is shown once per request, carrying the
 * device name only. The match code stays in the app, where it is compared.
 */
export function createAidenPairingRequestNotifier(
  dependencies: AidenPairingRequestNotifierDependencies,
): () => void {
  let announced = new Set<string>();
  return () => {
    dependencies.broadcast();
    const prompts = dependencies.list();
    const fresh = prompts.filter((prompt) => !announced.has(prompt.requestId));
    // Forget requests that have closed so the set stays bounded.
    announced = new Set(prompts.map((prompt) => prompt.requestId));
    for (const prompt of fresh) {
      try {
        if (!dependencies.isSupported()) return;
        const notification = dependencies.create({
          title: "Connection request",
          body: `${prompt.deviceName} wants to control this ${dependencies.hostNoun}. Open Aiden to compare the code.`,
        });
        notification.on("click", () => {
          try {
            dependencies.focusApp();
          } catch {
            dependencies.onError?.("focus");
          }
        });
        notification.show();
      } catch {
        dependencies.onError?.("delivery");
      }
    }
  };
}

export function aidenPairingRequestHostNoun(platform: NodeJS.Platform): string {
  return platform === "darwin" ? "Mac" : "computer";
}
