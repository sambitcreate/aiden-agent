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
  // A cleared subtitle must not fall through to the old one: main drops the
  // description when the update omits it, and the cache has to agree.
  const { description: baseDescription, ...rest } = base;
  const description = (patch.description ?? baseDescription ?? "").trim();
  return {
    ...rest,
    name: (patch.name ?? base.name).trim(),
    ...(description ? { description } : {}),
    instructions: patch.instructions ?? base.instructions,
    avatar: patch.avatar ?? base.avatar,
    ...(patch.chatActivity
      ? { chatActivity: { ...resolveBotChatActivity(base.chatActivity), ...patch.chatActivity } }
      : {}),
  };
}

/**
 * The edits in flight for one Bot: the last Bot main confirmed, with every
 * unanswered patch layered on top in the order it was made. The cache always
 * shows that stack, so overlapping edits settle correctly whatever order
 * their answers arrive in, and a failed one simply drops out of the stack.
 */
interface BotEditStack {
  confirmed: BotDefinition;
  pending: BotIdentityPatch[];
}

const editStacks = new Map<string, BotEditStack>();

function presentEdits(qc: QueryClient, stack: BotEditStack): void {
  placeBotInCache(
    qc,
    stack.pending.reduce<BotDefinition>((bot, patch) => patchedBot(bot, patch), stack.confirmed),
  );
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
 * Bot before main answers, and go back to the last confirmed Bot (plus any
 * other edit still in flight) if the save fails. The write itself still
 * rereads the Bot first, so it patches the latest revision rather than the one
 * this window happens to have cached.
 */
export async function updateBotIdentity(
  qc: QueryClient,
  botId: string,
  patch: BotIdentityPatch,
): Promise<BotDefinition> {
  let stack = editStacks.get(botId);
  if (!stack) {
    const cached = qc.getQueryData<BotDefinition>(queryKeys.bot(botId));
    if (cached) {
      stack = { confirmed: cached, pending: [] };
      editStacks.set(botId, stack);
    }
  }
  if (stack) {
    stack.pending.push(patch);
    presentEdits(qc, stack);
  }
  const settle = (confirmed: BotDefinition | null) => {
    if (!stack) return;
    stack.pending.splice(stack.pending.indexOf(patch), 1);
    if (confirmed) stack.confirmed = confirmed;
    if (stack.pending.length === 0) editStacks.delete(botId);
    presentEdits(qc, stack);
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
    settle(saved);
    void qc.invalidateQueries({ queryKey: queryKeys.bots });
    return saved;
  } catch (error) {
    settle(null);
    // The confirmed Bot this window held may be older than main's by now.
    if (stack && !editStacks.has(botId)) void qc.invalidateQueries({ queryKey: queryKeys.bot(botId) });
    throw error;
  }
}
