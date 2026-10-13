import { mcpProviderGrantKey } from "./mcp-provider-auth-core.js";
import * as fs from "fs/promises";
import * as path from "path";
import { randomUUID } from "node:crypto";
import { app, logger } from "../platform.js";
import { configStore } from "./config-store.js";
import {
  externalMcpCredentialCleanupKind,
  mcpCredentialCleanupAfterConfig,
  mcpCredentialCleanupSnapshot,
  mcpRuntimeConnectionSnapshot,
  parsePendingMcpCredentialCleanup,
  sameMcpRuntimeConnection,
  type McpRuntimeConnectionSnapshot,
  type PendingMcpCredentialCleanupV1,
} from "./mcp-credential-cleanup-core.js";
import { clearOAuth, invalidateMcpOAuthOperation, suspendMcpOAuthOperations } from "./mcp-oauth.js";
import { presetSecretId } from "./mcp-presets.js";
import { secrets } from "./secrets.js";
import { pruneStoredMcpFieldSecrets } from "./mcp-field-secrets.js";
import { mcpFieldSecretReferencesChanged } from "./mcp-field-secrets-core.js";
import { readRegularUtf8File } from "./regular-file-read.js";
import { mutatePortableConfigAndSync } from "./portable-credential-snapshot.js";
import type { McpServer } from "./types.js";
import { mcpConfigurationLeases } from "./mcp-config-lease.js";
import { syncDirectory } from "./durable-fs.js";
import { createMcpAdmissionQueue, McpPendingJournalState, singleFlight } from "./mcp-admission-queue.js";

const FILE = "pending-mcp-credential-cleanup.json";
const queue = createMcpAdmissionQueue();
// This process is the journal's only writer: once it has read, written or
// cleared the file it knows whether anything is pending without re-reading.
const journal = new McpPendingJournalState();

/** Mutations and reconciliation: one at a time, never during an admission. */
function serialized<R>(operation: () => Promise<R>): Promise<R> {
  return queue.exclusive(operation);
}

async function journalPath(): Promise<string> {
  const root = app.getPath("userData");
  await fs.mkdir(root, { recursive: true });
  return path.join(root, FILE);
}

async function readPending(): Promise<PendingMcpCredentialCleanupV1 | null> {
  const target = await journalPath();
  try {
    const pending = parsePendingMcpCredentialCleanup(JSON.parse(await readRegularUtf8File(target)));
    journal.observed(true);
    return pending;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      journal.observed(false);
      return null;
    }
    journal.uncertain();
    throw error;
  }
}

async function writePending(pending: PendingMcpCredentialCleanupV1): Promise<void> {
  // Pending (or uncertain) from before the first byte: a failed write still reads next time.
  journal.written();
  const target = await journalPath();
  const staged = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(staged, `${JSON.stringify(pending, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    const handle = await fs.open(staged, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(staged, target);
    await syncDirectory(path.dirname(target));
  } finally {
    await fs.rm(staged, { force: true }).catch(() => undefined);
  }
}

async function clearPending(): Promise<void> {
  const target = await journalPath();
  try {
    await fs.rm(target, { force: true });
    await syncDirectory(path.dirname(target));
  } catch (error) {
    journal.uncertain();
    throw error;
  }
  journal.cleared();
}

function assertCurrent(isCurrent: () => boolean): void {
  if (!isCurrent()) throw new Error("The renderer document is no longer active.");
}

async function reconcileNow(
  isCurrent: () => boolean = () => true,
  reloadFromDisk = true,
): Promise<void> {
  const pending = await readPending();
  if (!pending) return;
  const release = suspendMcpOAuthOperations(pending.serverId);
  try {
    assertCurrent(isCurrent);
    const safe = reloadFromDisk
      ? await configStore.portableConfigSafeForCredentialReconciliation()
      : await configStore.cachedPortableConfigSafeForCredentialReconciliation();
    if (!safe) {
      throw new Error("Portable config is not safe for MCP credential reconciliation.");
    }
    assertCurrent(isCurrent);
    const current = (await configStore.listMcpServers()).find(
      (server) => server.id === pending.serverId,
    );
    const cleanup = mcpCredentialCleanupAfterConfig(pending, current);
    if (!cleanup.resolved) {
      throw new Error("Pending MCP credential cleanup no longer matches its server.");
    }
    // Supersede anything that acquired a generation during the disk reload
    // immediately before committing credential deletion.
    invalidateMcpOAuthOperation(pending.serverId);
    assertCurrent(isCurrent);
    if (cleanup.clearOAuth) {
      await clearOAuth(pending.serverId, isCurrent);
      await secrets.deleteKey(mcpProviderGrantKey(pending.serverId), isCurrent);
    }
    if (cleanup.clearPresetKey) {
      await secrets.deleteKey(presetSecretId(pending.serverId), isCurrent);
    }
    // Env/header values the configured record no longer references (all of
    // them once the server is gone) leave the secrets store.
    await pruneStoredMcpFieldSecrets(pending.serverId, current, isCurrent);
    assertCurrent(isCurrent);
    await clearPending();
  } finally {
    release();
  }
}

export function reconcilePendingMcpCredentialCleanup(): Promise<void> {
  // Nothing to reconcile and nothing that could write the journal is queued.
  if (journal.knownEmpty() && !queue.exclusiveBusy()) return Promise.resolve();
  return serialized(reconcileNow);
}

/**
 * Admission-time reconciliation. Admissions for different servers run
 * concurrently, so they share one reconciliation rather than racing two.
 * Exclusive operations never run alongside an admission, so the journal
 * cannot change underneath it.
 */
const reconcileForAdmission = singleFlight(() => reconcileNow());

export function mutateMcpWithCredentialCleanup<R>(
  serverId: string,
  pendingForCurrent: (current: McpServer | undefined) => PendingMcpCredentialCleanupV1 | null,
  mutation: (current: McpServer | undefined) => Promise<R>,
  isCurrent: () => boolean = () => true,
): Promise<R> {
  return mutatePortableConfigAndSync(() =>
    serialized(async () => {
      await reconcileNow(isCurrent);
      assertCurrent(isCurrent);
      const current = (await configStore.listMcpServers()).find((server) => server.id === serverId);
      const pending = pendingForCurrent(current);
      const release = suspendMcpOAuthOperations(serverId);
      try {
        assertCurrent(isCurrent);
        if (pending) {
          await writePending(pending);
          assertCurrent(isCurrent);
        }
        const result = await mutation(current);
        if (pending) await reconcileNow(isCurrent);
        return result;
      } catch (error) {
        if (pending) {
          // A failed portable-config publication may have committed before its
          // durability error surfaced. Keep the journal until a fresh disk reload
          // can determine which config state is authoritative.
          logger.warn(
            "mcp",
            "MCP credential cleanup remains pending after config mutation failure.",
          );
        }
        throw error;
      } finally {
        release();
      }
    }),
  );
}

export function mutateCredentialForConfiguredMcp<R>(
  serverId: string,
  mutation: (server: Awaited<ReturnType<typeof configStore.listMcpServers>>[number]) => Promise<R>,
  isCurrent: () => boolean = () => true,
): Promise<R> {
  return serialized(async () => {
    await reconcileNow(isCurrent);
    assertCurrent(isCurrent);
    const configured = (await configStore.listMcpServers()).find(
      (server) => server.id === serverId,
    );
    if (!configured) throw new Error("This MCP server is no longer configured.");
    assertCurrent(isCurrent);
    return mutation(configured);
  });
}

export function withConfiguredMcp<R>(
  serverId: string,
  expected: McpRuntimeConnectionSnapshot | null,
  operation: () => Promise<R>,
  isCurrent: () => boolean = () => true,
  onAdmitted: () => void = () => undefined,
): Promise<R> {
  const admitted = queue.shared(serverId, async () => {
    if (!journal.knownEmpty()) await reconcileForAdmission();
    assertCurrent(isCurrent);
    const configured = (await configStore.listMcpServers()).find(
      (server) => server.id === serverId,
    );
    const actual = configured ? mcpRuntimeConnectionSnapshot(configured) : null;
    if (!sameMcpRuntimeConnection(actual, expected)) {
      throw new Error("This MCP server configuration changed. Try again.");
    }
    assertCurrent(isCurrent);
    onAdmitted();
  });
  return admitted.then(async () => {
    const result = await operation();
    assertCurrent(isCurrent);
    return result;
  });
}

export function reconcileExternalMcpCredentialChanges(
  previous: Awaited<ReturnType<typeof configStore.listMcpServers>>,
  current: Awaited<ReturnType<typeof configStore.listMcpServers>>,
  disconnect: (serverId: string) => Promise<void>,
): Promise<void> {
  return serialized(async () => {
    // External reconciliation is bound to the snapshot selected by the
    // watcher's authoritative reload. Do not consume a newer disk edit while
    // applying or committing this transition.
    await reconcileNow(() => true, false);
    for (const before of previous) {
      const after = current.find((server) => server.id === before.id);
      const previousRuntime = mcpRuntimeConnectionSnapshot(before);
      const targetRuntime = after ? mcpRuntimeConnectionSnapshot(after) : null;
      if (sameMcpRuntimeConnection(previousRuntime, targetRuntime)) continue;
      const previousSnapshot = mcpCredentialCleanupSnapshot(before);
      const targetSnapshot = after ? mcpCredentialCleanupSnapshot(after) : null;
      // Aiden's own move of unchanged values into the keychain is no credential change.
      const cleanupKind = externalMcpCredentialCleanupKind(before, after);
      // The DataStore cache-publication hook invalidates before the new
      // snapshot becomes visible. Repeat at reconciliation admission so a
      // lease acquired during the publication/reconciliation gap is fenced.
      mcpConfigurationLeases.invalidate(before.id);
      const release = suspendMcpOAuthOperations(before.id);
      try {
        await disconnect(before.id);
        if (cleanupKind) {
          await writePending({
            version: 1,
            kind: cleanupKind,
            serverId: before.id,
            previous: previousSnapshot,
            target: targetSnapshot,
          });
          await reconcileNow(() => true, false);
        }
        // Independently of sign-in cleanup: an edit that drops or renames a
        // stored env/header field (or removes the server) prunes its values
        // against this authoritative config, so restoring the old marker later
        // finds nothing.
        if (mcpFieldSecretReferencesChanged(before, after)) {
          await pruneStoredMcpFieldSecrets(before.id, after).catch((error: unknown) =>
            logger.warn("mcp", "Could not prune stored MCP env and header values after a config change.", error),
          );
        }
      } finally {
        release();
      }
    }
  });
}
