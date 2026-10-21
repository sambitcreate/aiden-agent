import type { QueryClient } from "@tanstack/react-query";
import { botsApi } from "../../lib/ipc";
import { queryKeys } from "../../lib/queries";
import { resolveBotChatActivity, type BotAvatar, type BotChatActivity, type BotDefinition } from "../../shared/bots";

export type BotIdentityPatch = Partial<{
  name: string;
  description: string;
  instructions: string;
  avatar: BotAvatar;
  /** Only the fields named here change; the rest keep the latest stored value. */
  chatActivity: Partial<BotChatActivity>;
}>;

/** The Bot as the renderer will show it once `patch` is applied to `base`. */
function patchedBot(base: BotDefinition, patch: BotIdentityPatch): BotDefinition {
  const next = { ...base, ...patch };
  const description = next.description?.trim();
  return {
    ...base,
    name: next.name.trim(),
    ...(description ? { description } : {}),
    instructions: next.instructions,
    avatar: next.avatar,
    ...(patch.chatActivity
      ? { chatActivity: { ...resolveBotChatActivity(base.chatActivity), ...patch.chatActivity } }
      : {}),
  };
}

/** Writes `bot` into its own query and into every cached Bots list that holds it. */
export function placeBotInCache(qc: QueryClient, bot: BotDefinition): void {
  qc.setQueryData(queryKeys.bot(bot.id), bot);
  qc.setQueriesData<BotDefinition[]>({ queryKey: queryKeys.bots }, (list) =>
    list?.some((row) => row.id === bot.id) ? list.map((row) => (row.id === bot.id ? bot : row)) : list,
  );
}

/** Adds a freshly created Bot to every cached Bots list, so it is listed before the list is reread. */
export function addBotToCache(qc: QueryClient, bot: BotDefinition): void {
  qc.setQueryData(queryKeys.bot(bot.id), bot);
  qc.setQueriesData<BotDefinition[]>({ queryKey: queryKeys.bots }, (list) =>
    list === undefined || list.some((row) => row.id === bot.id) ? list : [...list, bot],
  );
}

/** Drops a Bot from every cached Bots list; returns a function that puts it back (for a failed delete). */
export function removeBotFromCache(qc: QueryClient, botId: string): () => void {
  const removed: Array<readonly [readonly unknown[], BotDefinition[]]> = [];
  for (const [key, list] of qc.getQueriesData<BotDefinition[]>({ queryKey: queryKeys.bots })) {
    if (!list?.some((row) => row.id === botId)) continue;
    removed.push([key, list]);
    qc.setQueryData(key, list.filter((row) => row.id !== botId));
  }
  return () => {
    for (const [key, list] of removed) qc.setQueryData(key, list);
  };
}

/**
 * Applies only the edited identity fields onto the latest stored Bot, so a
 * change made on another device to a different field is kept.
 *
 * The change shows at once: the Bot's query and the Bots list take the patched
 * Bot before main answers, and go back to what they held if the save fails.
 * The write itself still rereads the Bot first, so it patches the latest
 * revision rather than the one this window happens to have cached.
 */
export async function updateBotIdentity(
  qc: QueryClient,
  botId: string,
  patch: BotIdentityPatch,
): Promise<BotDefinition> {
  const cached = qc.getQueryData<BotDefinition>(queryKeys.bot(botId));
  const optimistic = cached ? patchedBot(cached, patch) : null;
  if (optimistic) placeBotInCache(qc, optimistic);
  // Only this Bot's row goes back, and only where it still holds this edit's
  // copy: a list reread or a later edit that landed meanwhile is kept. The
  // query cache shares structure, so the copy is matched by value, not identity.
  const holdsOptimistic = (row: BotDefinition | undefined) =>
    row !== undefined && optimistic !== null && JSON.stringify(row) === JSON.stringify(optimistic);
  const rollback = () => {
    if (!cached || !optimistic) return;
    if (holdsOptimistic(qc.getQueryData<BotDefinition>(queryKeys.bot(botId)))) qc.setQueryData(queryKeys.bot(botId), cached);
    qc.setQueriesData<BotDefinition[]>({ queryKey: queryKeys.bots }, (list) =>
      list?.some(holdsOptimistic) ? list.map((row) => (holdsOptimistic(row) ? cached : row)) : list,
    );
  };
  try {
    const latest = await botsApi.get(botId);
    if (!latest) throw new Error("This Bot no longer exists.");
    const next = patchedBot(latest, patch);
    const saved = await botsApi.update({
      id: latest.id,
      expectedRevision: latest.revision,
      name: next.name,
      ...(next.description ? { description: next.description } : {}),
      instructions: next.instructions,
      avatar: next.avatar,
      ...(patch.chatActivity ? { chatActivity: resolveBotChatActivity(next.chatActivity) } : {}),
    });
    placeBotInCache(qc, saved);
    void qc.invalidateQueries({ queryKey: queryKeys.bots });
    return saved;
  } catch (error) {
    rollback();
    throw error;
  }
}
