import { createHash } from "node:crypto";
import type { NotificationChannel } from "../../renderer/preload-channels.js";
import { rendererDocumentOwner } from "./renderer-document-owner.js";

/**
 * Delivery and lifecycle authority for one generation. Renderer documents,
 * background services, and paired remote devices implement this same narrow
 * boundary without gaining each other's capabilities.
 */
export interface ChatGenerationOwner {
  /** Nonzero values identify renderer WebContents; headless owners use zero. */
  id: number;
  /** Stable turn-admission identity, independent of a network connection. */
  documentId: string;
  isDestroyed(): boolean;
  send(channel: NotificationChannel, payload: unknown): void;
  onInvalidated(listener: () => void): () => void;
}

export interface RemoteChatGenerationOwnerController {
  owner: ChatGenerationOwner;
  /** Explicit revocation/terminal cleanup; transport disconnect is not revocation. */
  invalidate(): void;
}

function boundedRemoteIdentity(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    Buffer.byteLength(value, "utf8") > 512
  ) {
    throw new Error(`Invalid remote ${label}.`);
  }
  return value;
}

function identityDigest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

/**
 * Create a paired-device generation owner whose authority survives socket and
 * SSE subscriber disconnects. The supplied publisher must target a durable
 * stream journal; only explicit invalidation revokes generation ownership.
 */
export function createRemoteChatGenerationOwner(input: {
  deviceId: string;
  streamId: string;
  publish(channel: NotificationChannel, payload: unknown): void;
}): RemoteChatGenerationOwnerController {
  const deviceId = boundedRemoteIdentity(input.deviceId, "device identity");
  const streamId = boundedRemoteIdentity(input.streamId, "stream identity");
  let invalidated = false;
  const listeners = new Set<() => void>();
  const owner: ChatGenerationOwner = {
    id: 0,
    documentId: `remote:${identityDigest(deviceId)}:${identityDigest(streamId)}`,
    isDestroyed: () => invalidated,
    send: (channel, payload) => {
      if (invalidated) throw new Error("The remote generation owner is no longer active.");
      input.publish(channel, payload);
    },
    onInvalidated: (listener) => {
      if (invalidated) {
        listener();
        return () => undefined;
      }
      listeners.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
      };
    },
  };
  return {
    owner,
    invalidate: () => {
      if (invalidated) return;
      invalidated = true;
      for (const listener of [...listeners]) {
        listeners.delete(listener);
        try {
          listener();
        } catch {
          // Revocation must notify every listener even if one cleanup fails.
        }
      }
    },
  };
}

/** Bind a generation, its stream, cancellation, and approvals to one renderer document. */
export function chatGenerationOwner(event: Electron.IpcMainInvokeEvent): ChatGenerationOwner {
  return rendererDocumentOwner(
    event,
    () => new Error("Chat generation must start from the active application document."),
  );
}
