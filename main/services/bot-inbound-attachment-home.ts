import path from "node:path";
import type { BotManagedWorkspaceResolution } from "./bot-managed-workspace-core.js";

export interface ResolveBotInboundAttachmentHomeInput {
  /** Absent identifies an ordinary route, which keeps its existing inbox. */
  botId?: string;
  workspaceId?: string;
  resolveManagedWorkspace(botId: string): Promise<BotManagedWorkspaceResolution>;
  revalidateManagedWorkspace(
    expected: BotManagedWorkspaceResolution,
  ): Promise<BotManagedWorkspaceResolution>;
  canonicalize(candidate: string): Promise<string>;
}

export interface BotInboundAttachmentHomeLease {
  readonly homePath: string;
  readonly identity: Readonly<{ device: string; inode: string }>;
  /** Must be awaited immediately before and after each filesystem effect. */
  revalidateBeforeEffect(): Promise<void>;
}

/**
 * Resolve the only valid local-file destination for a Bot-bound inbound item.
 * Returning undefined is reserved for ordinary, non-Bot surfaces. Once botId
 * is present every mismatch fails closed instead of falling back to userData.
 */
export async function resolveBotInboundAttachmentHome(
  input: ResolveBotInboundAttachmentHomeInput,
): Promise<BotInboundAttachmentHomeLease | undefined> {
  if (input.botId === undefined) return undefined;
  if (!input.workspaceId) {
    throw new Error("This Bot attachment is missing its managed home workspace.");
  }
  const managed = await input.resolveManagedWorkspace(input.botId);
  if (
    managed.botId !== input.botId ||
    managed.workspaceId !== input.workspaceId
  ) {
    throw new Error("This Bot attachment does not match its managed home workspace.");
  }
  if (
    !path.isAbsolute(managed.homePath) ||
    path.normalize(managed.homePath) !== managed.homePath ||
    managed.homePath === path.parse(managed.homePath).root
  ) {
    throw new Error("This Bot attachment has an unsafe managed home workspace.");
  }
  const revalidateBeforeEffect = async (): Promise<void> => {
    const current = await input.revalidateManagedWorkspace(managed);
    if (
      current.botId !== managed.botId ||
      current.workspaceId !== managed.workspaceId ||
      current.createdAt !== managed.createdAt ||
      current.homePath !== managed.homePath ||
      current.incarnation.device !== managed.incarnation.device ||
      current.incarnation.inode !== managed.incarnation.inode ||
      (await input.canonicalize(current.homePath)) !== managed.homePath
    ) {
      throw new Error("This Bot attachment's managed home workspace changed.");
    }
  };
  await revalidateBeforeEffect();
  return Object.freeze({
    homePath: managed.homePath,
    identity: Object.freeze({ ...managed.incarnation }),
    revalidateBeforeEffect,
  });
}
