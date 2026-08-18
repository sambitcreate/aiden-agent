import * as React from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Archive, ArrowLeft, Bot, Link2, MessageSquarePlus, Pencil, Plus, RotateCcw, Unlink } from "lucide-react";
import { BotAvatar } from "../components/bot-avatar";
import { Button, Dialog, EmptyState, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Text, Textarea, toast } from "../components/ui";
import { botsApi } from "../lib/ipc";
import { queryKeys, useBotChats, useBots, useBotTelegramBinding, useBotTelegramTargets } from "../lib/queries";
import { useActiveWorkspace } from "../lib/workspace-context";
import { BOT_AVATARS, BOT_AVATAR_LABELS, type BotAvatar as BotAvatarName, type BotDefinition } from "../shared/bots";

type BotDraft = { name: string; description: string; instructions: string; avatar: BotAvatarName };
const emptyDraft: BotDraft = { name: "", description: "", instructions: "", avatar: "spark" };
const botChatDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

function BotEditor({ bot, open, onOpenChange }: {
  bot: BotDefinition | null;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [draft, setDraft] = React.useState<BotDraft>(emptyDraft);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setDraft(
      bot
        ? {
            name: bot.name,
            description: bot.description ?? "",
            instructions: bot.instructions,
            avatar: bot.avatar,
          }
        : emptyDraft,
    );
  }, [bot, open]);

  const save = async () => {
    setSaving(true);
    try {
      const input = {
        name: draft.name,
        description: draft.description.trim() || undefined,
        instructions: draft.instructions,
        avatar: draft.avatar,
      };
      const saved = bot
        ? await botsApi.update({ id: bot.id, ...input })
        : await botsApi.create(input);
      await qc.invalidateQueries({ queryKey: queryKeys.bots });
      qc.setQueryData(queryKeys.bot(saved.id), saved);
      onOpenChange(false);
      if (!bot) await navigate({ to: "/bots/$botId", params: { botId: saved.id } });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Aiden could not save this bot.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={bot ? `Edit ${bot.name}` : "Create a bot"}
      description="Give this Pi-powered teammate a durable identity and working style. Workspace permissions and tools still come from each conversation."
      confirmLabel={bot ? "Save changes" : "Create bot"}
      confirmDisabled={!draft.name.trim() || !draft.instructions.trim()}
      busy={saving}
      onConfirm={save}
      size="large"
    >
      <div className="space-y-4">
        <label className="block">
          <Text variant="small-strong">Name</Text>
          <Input autoFocus className="mt-1.5" value={draft.name} maxLength={80} placeholder="Release reviewer" onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
        </label>
        <label className="block">
          <Text variant="small-strong">Short description</Text>
          <Input className="mt-1.5" value={draft.description} maxLength={280} placeholder="What this bot is best at" onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} />
        </label>
        <fieldset>
          <Text as="legend" variant="small-strong">Avatar</Text>
          <div className="mt-2 flex flex-wrap gap-2">
            {BOT_AVATARS.map((avatar) => (
              <button
                key={avatar}
                type="button"
                aria-label={`${BOT_AVATAR_LABELS[avatar]} avatar`}
                aria-pressed={draft.avatar === avatar}
                className={`rounded-card outline-none transition-[background-color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-focus-ring ${draft.avatar === avatar ? "bg-accent/15" : ""}`}
                onClick={() => setDraft((current) => ({ ...current, avatar }))}
              >
                <BotAvatar avatar={avatar} name={BOT_AVATAR_LABELS[avatar]} />
              </button>
            ))}
          </div>
        </fieldset>
        <label className="block">
          <Text variant="small-strong">Instructions</Text>
          <Text as="span" variant="small" color="tertiary" className="ml-2">Applied to every new turn</Text>
          <Textarea
            className="mt-1.5 min-h-40 resize-y"
            value={draft.instructions}
            maxLength={32_000}
            placeholder="Describe the role, priorities, tone, and how this bot should approach work."
            onChange={(event) => setDraft((current) => ({ ...current, instructions: event.target.value }))}
          />
        </label>
      </div>
    </Dialog>
  );
}

function Roster({ bots, onCreate }: { bots: BotDefinition[]; onCreate(): void }) {
  const navigate = useNavigate();
  const active = bots.filter((bot) => bot.archivedAt === undefined);
  const archived = bots.filter((bot) => bot.archivedAt !== undefined);
  if (bots.length === 0) {
    return (
      <div className="space-y-4 text-center">
        <EmptyState
          title="Create your first bot"
          description="Make a reusable Pi-powered teammate with its own role and instructions."
        />
        <Button variant="accent" onClick={onCreate}><Plus /> Create bot</Button>
      </div>
    );
  }
  return (
    <div className="space-y-8">
      {[{ title: "Your bots", items: active }, { title: "Archived", items: archived }].map((group) =>
        group.items.length ? (
          <section key={group.title}>
            <Text as="h2" variant="small-strong" color="secondary">{group.title}</Text>
            <div className="mt-2 grid grid-cols-2 gap-3 max-[760px]:grid-cols-1">
              {group.items.map((bot) => (
                <button
                  key={bot.id}
                  type="button"
                  className="flex min-h-28 items-start gap-3 rounded-card border border-field bg-well p-4 text-left outline-none transition-[background-color,border-color,box-shadow] duration-150 hover:border-separator hover:bg-control-hover hover:shadow-control focus-visible:border-focus-ring focus-visible:bg-control-hover"
                  onClick={() => navigate({ to: "/bots/$botId", params: { botId: bot.id } })}
                >
                  <BotAvatar avatar={bot.avatar} name={bot.name} size="large" />
                  <span className="min-w-0 flex-1">
                    <Text as="span" variant="strong" className="block truncate">{bot.name}</Text>
                    <Text as="span" variant="small" color="secondary" className="mt-1 line-clamp-2 block">
                      {bot.description ?? "A reusable Pi-powered teammate."}
                    </Text>
                    {bot.archivedAt ? <Text as="span" variant="small" color="tertiary" className="mt-2 block">Archived</Text> : null}
                  </span>
                </button>
              ))}
            </div>
          </section>
        ) : null,
      )}
    </div>
  );
}

export function BotsView() {
  const params = useParams({ strict: false }) as { botId?: string };
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { activeId } = useActiveWorkspace();
  const bots = useBots(true);
  const chats = useBotChats(params.botId);
  const telegramBinding = useBotTelegramBinding(params.botId);
  const selected = bots.data?.find((bot) => bot.id === params.botId);
  const [editorOpen, setEditorOpen] = React.useState(false);
  const [editorBot, setEditorBot] = React.useState<BotDefinition | null>(null);
  const [starting, setStarting] = React.useState(false);
  const [archiving, setArchiving] = React.useState(false);
  const [telegramOpen, setTelegramOpen] = React.useState(false);
  const [telegramTarget, setTelegramTarget] = React.useState("");
  const [telegramSaving, setTelegramSaving] = React.useState(false);
  const telegramTargets = useBotTelegramTargets(telegramOpen);

  const openCreate = () => { setEditorBot(null); setEditorOpen(true); };
  const openEdit = () => { if (selected) { setEditorBot(selected); setEditorOpen(true); } };
  const startConversation = async () => {
    if (!selected || !activeId || selected.archivedAt) return;
    setStarting(true);
    try {
      const chat = await botsApi.createChat({ botId: selected.id, workspaceId: activeId });
      await qc.invalidateQueries({ queryKey: queryKeys.botChats(selected.id) });
      await navigate({ to: "/bots/$botId/chat/$chatId", params: { botId: selected.id, chatId: chat.id } });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Aiden could not start the conversation.");
    } finally {
      setStarting(false);
    }
  };
  const toggleArchive = async () => {
    if (!selected) return;
    setArchiving(true);
    try {
      const next = selected.archivedAt ? await botsApi.restore(selected.id) : await botsApi.archive(selected.id);
      qc.setQueryData(queryKeys.bot(selected.id), next);
      if (!selected.archivedAt) qc.setQueryData(queryKeys.botTelegramBinding(selected.id), null);
      await qc.invalidateQueries({ queryKey: queryKeys.bots });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Aiden could not update this bot.");
    } finally {
      setArchiving(false);
    }
  };
  const bindTelegram = async () => {
    if (!selected || !telegramTarget) return;
    const target = telegramTargets.data?.[Number(telegramTarget)];
    if (!target) return;
    setTelegramSaving(true);
    try {
      const binding = await botsApi.bindTelegram({
        botId: selected.id,
        profile: target.profile,
        ...(target.threadId === undefined ? {} : { threadId: target.threadId }),
      });
      qc.setQueryData(queryKeys.botTelegramBinding(selected.id), binding);
      setTelegramOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Aiden could not bind this Telegram chat.");
    } finally {
      setTelegramSaving(false);
    }
  };
  const unbindTelegram = async () => {
    if (!selected) return;
    setTelegramSaving(true);
    try {
      await botsApi.unbindTelegram(selected.id);
      qc.setQueryData(queryKeys.botTelegramBinding(selected.id), null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Aiden could not unbind this Telegram chat.");
    } finally {
      setTelegramSaving(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <main className="mx-auto w-full max-w-5xl px-8 pb-16 pt-16 max-[640px]:px-5">
        {params.botId ? (
          selected ? (
            <>
              <Button variant="transparent" size="small" onClick={() => navigate({ to: "/bots" })}><ArrowLeft /> All bots</Button>
              <header className="mt-6 flex items-start justify-between gap-5 max-[680px]:flex-col">
                <div className="flex min-w-0 items-start gap-4">
                  <BotAvatar avatar={selected.avatar} name={selected.name} size="large" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Text as="h1" variant="heading1" className="truncate">{selected.name}</Text>
                      <span className="rounded-pill bg-control px-2 py-0.5 text-mini font-medium text-secondary">Bot</span>
                    </div>
                    <Text as="p" color="secondary" className="mt-1 max-w-2xl">{selected.description ?? "A reusable Pi-powered teammate."}</Text>
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button variant="filled" onClick={openEdit}><Pencil /> Edit</Button>
                  <Button variant="filled" disabled={archiving} onClick={() => void toggleArchive()}>
                    {selected.archivedAt ? <RotateCcw /> : <Archive />}{selected.archivedAt ? "Restore" : "Archive"}
                  </Button>
                </div>
              </header>
              {selected.archivedAt ? (
                <div className="mt-6 rounded-card border border-field bg-well px-4 py-3 text-regular text-secondary">
                  This bot is archived. Its conversations remain available, but it cannot start or continue work until restored.
                </div>
              ) : null}
              <section className="mt-10" aria-labelledby="bot-conversations-title">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <Text id="bot-conversations-title" as="h2" variant="strong">Conversations</Text>
                    <Text as="p" variant="small" color="secondary" className="mt-1">Each conversation keeps its own workspace, model, and Pi session.</Text>
                  </div>
                  <Button variant="accent" disabled={!activeId || Boolean(selected.archivedAt) || starting} onClick={() => void startConversation()}>
                    <MessageSquarePlus /> {starting ? "Starting…" : "New conversation"}
                  </Button>
                </div>
                <div className="mt-4 overflow-hidden rounded-card border border-field bg-well">
                  {chats.isLoading ? (
                    <Text as="p" color="secondary" className="p-5">Loading conversations…</Text>
                  ) : chats.isError ? (
                    <div className="space-y-3 p-5">
                      <Text as="p" color="secondary">Aiden could not load this bot’s conversations.</Text>
                      <Button size="small" variant="filled" onClick={() => void chats.refetch()}><RotateCcw /> Try again</Button>
                    </div>
                  ) : (chats.data?.length ?? 0) === 0 ? (
                    <EmptyState placement="inline" title="No conversations yet" description="Start one in the active workspace when you are ready." />
                  ) : (
                    chats.data?.map((chat, index) => (
                      <button
                        key={chat.id}
                        type="button"
                        className={`flex w-full items-center gap-3 px-4 py-3 text-left outline-none transition-colors duration-150 hover:bg-control-hover focus-visible:bg-list-selection ${index ? "border-t border-separator" : ""}`}
                        onClick={() => navigate({ to: "/bots/$botId/chat/$chatId", params: { botId: selected.id, chatId: chat.id } })}
                      >
                        <Bot className="size-4 text-secondary" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate text-regular text-primary">{chat.title}</span>
                        <span className="text-small text-tertiary">{botChatDateFormatter.format(chat.updatedAt)}</span>
                      </button>
                    ))
                  )}
                </div>
              </section>
              <section className="mt-10" aria-labelledby="bot-instructions-title">
                <Text id="bot-instructions-title" as="h2" variant="small-strong" color="secondary">Instructions</Text>
                <p className="mt-2 whitespace-pre-wrap rounded-card bg-well p-4 text-regular leading-6 text-primary">{selected.instructions}</p>
              </section>
              <section className="mt-10 rounded-card border border-field bg-well p-4" aria-labelledby="bot-telegram-title">
                <div className="flex items-center justify-between gap-4 max-[620px]:items-start max-[620px]:flex-col">
                  <div>
                    <Text id="bot-telegram-title" as="h2" variant="strong">Telegram control</Text>
                    <Text as="p" variant="small" color="secondary" className="mt-1">
                      {telegramBinding.isLoading
                        ? "Checking the one-to-one Telegram binding…"
                        : telegramBinding.isError
                          ? "Aiden could not load this bot’s Telegram binding."
                        : telegramBinding.data
                          ? `Bound to ${telegramBinding.data.profile}${telegramBinding.data.threadId ? ` · topic ${telegramBinding.data.threadId}` : " · direct message"}.`
                          : "Bind one paired Telegram chat to control this bot remotely."}
                    </Text>
                  </div>
                  {telegramBinding.isError ? (
                    <Button variant="filled" disabled={telegramBinding.isFetching} onClick={() => void telegramBinding.refetch()}><RotateCcw /> Try again</Button>
                  ) : telegramBinding.data ? (
                    <Button variant="filled" disabled={telegramSaving || Boolean(selected.archivedAt)} onClick={() => void unbindTelegram()}><Unlink /> Unbind</Button>
                  ) : (
                    <Button variant="filled" disabled={telegramBinding.isLoading || Boolean(selected.archivedAt)} onClick={() => { setTelegramTarget(""); setTelegramOpen(true); }}><Link2 /> Bind Telegram</Button>
                  )}
                </div>
                <Text as="p" variant="small" color="tertiary" className="mt-3">Tokens, owner pairing, model, and workspace stay managed in Settings → Telegram.</Text>
              </section>
            </>
          ) : bots.isLoading ? (
            <Text color="secondary">Loading bot…</Text>
          ) : (
            <EmptyState title="Bot not found" description="This bot may have been removed from local storage." />
          )
        ) : (
          <>
            <header className="flex items-end justify-between gap-4">
              <div>
                <Text as="h1" variant="heading1">Bots</Text>
                <Text as="p" color="secondary" className="mt-1 max-w-2xl">Create reusable teammates that stay on top of Aiden’s existing Pi runtime.</Text>
              </div>
              <Button variant="accent" onClick={openCreate}><Plus /> New bot</Button>
            </header>
            <div className="mt-8">
              {bots.isLoading ? (
                <Text color="secondary">Loading bots…</Text>
              ) : bots.isError ? (
                <div className="space-y-3 rounded-card bg-well p-5">
                  <Text as="p" color="secondary">Aiden could not load your bots.</Text>
                  <Button size="small" variant="filled" onClick={() => void bots.refetch()}><RotateCcw /> Try again</Button>
                </div>
              ) : (
                <Roster bots={bots.data ?? []} onCreate={openCreate} />
              )}
            </div>
          </>
        )}
      </main>
      <BotEditor bot={editorBot} open={editorOpen} onOpenChange={setEditorOpen} />
      <Dialog
        open={telegramOpen}
        onOpenChange={setTelegramOpen}
        title="Bind Telegram chat"
        description="One exact direct message or private topic will route to this bot’s durable Pi conversation. A target can belong to only one bot."
        confirmLabel="Bind chat"
        confirmDisabled={!telegramTarget || telegramTargets.isLoading || telegramTargets.isError}
        busy={telegramSaving}
        onConfirm={bindTelegram}
      >
        {telegramTargets.isLoading ? (
          <Text color="secondary">Loading paired Telegram chats…</Text>
        ) : telegramTargets.isError ? (
          <div className="space-y-3">
            <Text color="secondary">Aiden could not load Telegram targets.</Text>
            <Button size="small" variant="filled" onClick={() => void telegramTargets.refetch()}><RotateCcw /> Try again</Button>
          </div>
        ) : (telegramTargets.data?.length ?? 0) === 0 ? (
          <EmptyState placement="inline" title="No bindable Telegram chats" description="Add a bot token, pair its owner, and choose a folder workspace in Settings → Telegram first." />
        ) : (
          <label className="block">
            <Text variant="small-strong">Telegram target</Text>
            <Select value={telegramTarget} onValueChange={setTelegramTarget}>
              <SelectTrigger className="mt-1.5 w-full" aria-label="Telegram target"><SelectValue placeholder="Choose a chat" /></SelectTrigger>
              <SelectContent>
                {telegramTargets.data?.map((target, index) => (
                  <SelectItem key={`${target.profile}:${target.threadId ?? "dm"}`} value={String(index)} disabled={!target.enabled || !target.workspaceId}>
                    {target.label}{target.workspaceName ? ` · ${target.workspaceName}` : " · choose workspace first"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        )}
      </Dialog>
    </div>
  );
}
