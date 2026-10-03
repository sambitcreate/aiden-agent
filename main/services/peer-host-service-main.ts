import os from "node:os";
import type { NotificationChannel } from "../../renderer/preload-channels.js";
import { app, ipcMain, powerMonitor, safeStorage } from "../platform.js";
import { DataStore } from "./data-store.js";
import {
  EncryptedPeerHostStorage,
  type PeerEncryptedDocument,
} from "./peer-host-storage.js";
import { PeerHostRegistry } from "./peer-host-registry.js";
import { PeerHostManager, peerNetworkFingerprint } from "./peer-host-manager.js";
import { getAidenRemoteRuntime } from "./aiden-remote-service-main.js";

let registry: PeerHostRegistry | undefined;
let manager: PeerHostManager | undefined;

/** How often the network fingerprint is compared while any host is supervised. */
const NETWORK_CHECK_MS = 15_000;

export function getPeerHostRegistry(): PeerHostRegistry {
  if (registry) return registry;
  const store = new DataStore<PeerEncryptedDocument>(
    "paired-hosts.json",
    { version: 1, ciphertext: null },
    () => app.getPath("userData"),
    {
      maxBytes: 600000,
      fileMode: 0o600,
      rejectCorruptWrite: true,
      rejectUnsafeWrite: true,
      isSafe: (value) =>
        !!value &&
        typeof value === "object" &&
        (value as PeerEncryptedDocument).version === 1 &&
        ((value as PeerEncryptedDocument).ciphertext === null ||
          typeof (value as PeerEncryptedDocument).ciphertext === "string"),
    },
  );
  registry = new PeerHostRegistry({
    storage: new EncryptedPeerHostStorage(
      {
        load: async () => {
          const value = await store.load();
          if (
            (await store.loadedFromCorruptFile()) ||
            (await store.loadedFromUnsafeFile())
          )
            throw new Error("Paired-device storage needs recovery.");
          return value;
        },
        save: (value, isCurrent) => store.save(value, isCurrent),
      },
      {
        isEncryptionAvailable: () =>
          safeStorage.isEncryptionAvailable() &&
          (process.platform !== "linux" ||
            !["basic_text", "unknown"].includes(
              safeStorage.getSelectedStorageBackend(),
            )),
        encryptString: (value) => safeStorage.encryptString(value),
        decryptString: (value) => safeStorage.decryptString(value),
      },
    ),
    localInstanceId: async () =>
      (await (await getAidenRemoteRuntime()).state.snapshot()).instanceId,
    deviceName: os.hostname().slice(0, 80) || "Aiden desktop",
    clientVersion: app.getVersion(),
    platform: process.platform === "linux" ? "linux" : "mac",
    changed: () => ipcMain.broadcast("remote:peers-changed", {}),
  });
  app.once("before-quit", () => registry?.close());
  return registry;
}

/**
 * The connection supervisor, started on first use so a launch with no device
 * UI makes no peer traffic. Sleep/resume, unlock and network changes wake it.
 */
export function getPeerHostManager(): PeerHostManager {
  if (manager) return manager;
  const current = new PeerHostManager({
    registry: getPeerHostRegistry(),
    broadcast: (channel, payload) =>
      ipcMain.broadcast(channel as NotificationChannel, payload),
  });
  manager = current;
  const wake = (): void => current.wake();
  powerMonitor.on("resume", wake);
  powerMonitor.on("unlock-screen", wake);
  let network = peerNetworkFingerprint(os.networkInterfaces());
  const watcher = setInterval(() => {
    if (current.supervising === 0) return;
    const next = peerNetworkFingerprint(os.networkInterfaces());
    if (next === network) return;
    network = next;
    current.wake();
  }, NETWORK_CHECK_MS);
  watcher.unref?.();
  app.once("before-quit", () => {
    clearInterval(watcher);
    powerMonitor.removeListener("resume", wake);
    powerMonitor.removeListener("unlock-screen", wake);
    current.close();
  });
  return current;
}
