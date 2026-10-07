import type { QueryClient } from "@tanstack/react-query";
import { botsApi } from "../../lib/ipc";
import { queryKeys } from "../../lib/queries";
import type { BotAvatar, BotDefinition } from "../../shared/bots";

export type BotIdentityPatch = Partial<{
  name: string;
  description: string;
  instructions: string;
  openingGreeting: string;
  avatar: BotAvatar;
}>;

/**
 * Applies only the edited identity fields onto the latest stored Bot, so a
 * change made on another device to a different field is kept.
 */
export async function updateBotIdentity(
  qc: QueryClient,
  botId: string,
  patch: BotIdentityPatch,
): Promise<BotDefinition> {
  const latest = await botsApi.get(botId);
  if (!latest) throw new Error("This Bot no longer exists.");
  const next = { ...latest, ...patch };
  const description = next.description?.trim();
  const openingGreeting = next.openingGreeting?.trim();
  const saved = await botsApi.update({
    id: latest.id,
    expectedRevision: latest.revision,
    name: next.name.trim(),
    ...(description ? { description } : {}),
    instructions: next.instructions,
    ...(openingGreeting ? { openingGreeting } : {}),
    avatar: next.avatar,
  });
  qc.setQueryData(queryKeys.bot(saved.id), saved);
  await qc.invalidateQueries({ queryKey: queryKeys.bots });
  return saved;
}
