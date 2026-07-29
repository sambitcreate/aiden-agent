import type { CommandId } from "../../renderer/shared/keybindings.js";

export interface ShortcutRegistrationPort {
  register(accelerator: string, handler: () => void): boolean | Promise<boolean>;
  unregister(accelerator: string): void;
}

export interface DesiredGlobalShortcut {
  commandId: CommandId;
  accelerator: string | null;
  handler: () => void;
}

export interface RegisteredGlobalShortcut extends DesiredGlobalShortcut {
  accelerator: string;
}

export interface ShortcutReconcileResult {
  ok: boolean;
  registered: Map<CommandId, RegisteredGlobalShortcut>;
  failedCommandId?: CommandId;
  failedAccelerator?: string;
  rollbackFailed?: boolean;
}

/**
 * Atomically replace only changed global registrations. Unchanged shortcuts
 * remain claimed, and a failed claim restores every released registration.
 */
export async function reconcileGlobalShortcuts(
  port: ShortcutRegistrationPort,
  current: ReadonlyMap<CommandId, RegisteredGlobalShortcut>,
  desired: readonly DesiredGlobalShortcut[],
): Promise<ShortcutReconcileResult> {
  const desiredById = new Map(desired.map((item) => [item.commandId, item]));
  const changedIds = new Set<CommandId>();
  for (const item of desired) {
    if (current.get(item.commandId)?.accelerator !== item.accelerator)
      changedIds.add(item.commandId);
  }
  for (const id of current.keys()) {
    if (!desiredById.has(id)) changedIds.add(id);
  }
  if (changedIds.size === 0) {
    return { ok: true, registered: new Map(current) };
  }

  const next = new Map(current);
  const released: RegisteredGlobalShortcut[] = [];
  for (const id of changedIds) {
    const existing = current.get(id);
    if (!existing) continue;
    port.unregister(existing.accelerator);
    released.push(existing);
    next.delete(id);
  }

  const newlyRegistered: RegisteredGlobalShortcut[] = [];
  for (const item of desired) {
    if (!changedIds.has(item.commandId) || !item.accelerator) continue;
    const ok = await port.register(item.accelerator, item.handler);
    if (ok) {
      const registered = { ...item, accelerator: item.accelerator };
      newlyRegistered.push(registered);
      next.set(item.commandId, registered);
      continue;
    }

    for (const registered of newlyRegistered) {
      port.unregister(registered.accelerator);
      next.delete(registered.commandId);
    }
    let rollbackFailed = false;
    for (const previous of released) {
      if (await port.register(previous.accelerator, previous.handler)) {
        next.set(previous.commandId, previous);
      } else {
        rollbackFailed = true;
      }
    }
    return {
      ok: false,
      registered: next,
      failedCommandId: item.commandId,
      failedAccelerator: item.accelerator,
      rollbackFailed,
    };
  }

  return { ok: true, registered: next };
}
