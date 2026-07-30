import * as fs from "fs/promises";
import * as path from "path";
import { randomUUID } from "node:crypto";
import { app, logger } from "../platform.js";
import { configStore } from "./config-store.js";
import {
  mcpCredentialCleanupAfterConfig,
  mcpCredentialConnectionSnapshot,
  mcpRuntimeConnectionSnapshot,
  parsePendingMcpCredentialCleanup,
  sameMcpCredentialConnection,
  sameMcpRuntimeConnection,
  type McpRuntimeConnectionSnapshot,
  type PendingMcpCredentialCleanupV1,
} from "./mcp-credential-cleanup-core.js";
import { clearOAuth, invalidateMcpOAuthOperation, suspendMcpOAuthOperations } from "./mcp-oauth.js";
import { presetSecretId } from "./mcp-presets.js";
import { secrets } from "./secrets.js";
import { readRegularUtf8File } from "./regular-file-read.js";
import { mutatePortableConfigAndSync } from "./portable-credential-snapshot.js";
import type { McpServer } from "./types.js";

const FILE = "pending-mcp-credential-cleanup.json";
let cleanupTail: Promise<void> = Promise.resolve();

function serialized<R>(operation: () => Promise<R>): Promise<R> {
  const result = cleanupTail.then(operation, operation);
  cleanupTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function journalPath(): Promise<string> {
  const root = app.getPath("userData");
  await fs.mkdir(root, { recursive: true });
  return path.join(root, FILE);
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readPending(): Promise<PendingMcpCredentialCleanupV1 | null> {
  const target = await journalPath();
  try {
    return parsePendingMcpCredentialCleanup(JSON.parse(await readRegularUtf8File(target)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writePending(pending: PendingMcpCredentialCleanupV1): Promise<void> {
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
  await fs.rm(target, { force: true });
  await syncDirectory(path.dirname(target));
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
    if (cleanup.clearOAuth) await clearOAuth(pending.serverId, isCurrent);
    if (cleanup.clearPresetKey) {
      await secrets.deleteKey(presetSecretId(pending.serverId), isCurrent);
    }
    assertCurrent(isCurrent);
    await clearPending();
  } finally {
    release();
  }
}

export function reconcilePendingMcpCredentialCleanup(): Promise<void> {
  return serialized(reconcileNow);
}

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

export function mutateMcpConfig<R>(
  serverId: string,
  mutation: () => Promise<R>,
  isCurrent: () => boolean = () => true,
): Promise<R> {
  return mutatePortableConfigAndSync(() =>
    serialized(async () => {
      await reconcileNow(isCurrent);
      const release = suspendMcpOAuthOperations(serverId);
      try {
        assertCurrent(isCurrent);
        return await mutation();
      } finally {
        release();
      }
    }),
  );
}

export function withConfiguredMcp<R>(
  serverId: string,
  expected: McpRuntimeConnectionSnapshot | null,
  operation: () => Promise<R>,
  isCurrent: () => boolean = () => true,
  onAdmitted: () => void = () => undefined,
): Promise<R> {
  const admitted = serialized(async () => {
    await reconcileNow(isCurrent);
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
      const previousSnapshot = mcpCredentialConnectionSnapshot(before);
      const targetSnapshot = after ? mcpCredentialConnectionSnapshot(after) : null;
      const credentialChanged = !sameMcpCredentialConnection(previousSnapshot, targetSnapshot);
      const release = suspendMcpOAuthOperations(before.id);
      try {
        await disconnect(before.id);
        if (credentialChanged) {
          const kind = !after
            ? "remove"
            : before.oauth && !after.oauth
              ? "disable-oauth"
              : "replace";
          await writePending({
            version: 1,
            kind,
            serverId: before.id,
            previous: previousSnapshot,
            target: targetSnapshot,
          });
          await reconcileNow(() => true, false);
        }
      } finally {
        release();
      }
    }
  });
}
