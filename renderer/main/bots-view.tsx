import * as React from "react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useQueries } from "@tanstack/react-query";
import { Button, EmptyState, ScrollArea } from "../components/ui";
import { botsApi } from "../lib/ipc";
import { useBot, useBots } from "../lib/queries";
import type { BotDefinition } from "../shared/bots";
import { BotAdvanced } from "./bots/bot-advanced";
import { BotCreateFlow } from "./bots/bot-create-flow";
import { BotDeleteDialog } from "./bots/bot-delete-dialog";
import { BotInstructionsEditor } from "./bots/bot-instructions-editor";
import { BotList, type BotListRow } from "./bots/bot-list";
import { BotMemoryPage } from "./bots/bot-memory-page";
import { BotPageShell, BotPageSkeleton } from "./bots/bot-page-shell";
import { parseBotPageSearch, type BotSubpage } from "./bots/bot-page-search";
import { BotProfile } from "./bots/bot-profile";
import { BotStarterCarousel } from "./bots/bot-starter-carousel";
import { RemoteBots } from "./remote-bots";

/** The Bot's one conversation, addressed by Bot id only. */
export function botChatPath(botId: string): { to: "/bots/$botId/chat"; params: { botId: string } } {
  return { to: "/bots/$botId/chat", params: { botId } };
}

function BotsHome() {
  const navigate = useNavigate();
  const bots = useBots();
  const active = bots.data ?? [];
  // Preview, time and state come from the same live projection the chat reads.
  const summaries = useQueries({
    queries: active.map((bot) => ({
      queryKey: ["bot-live-summary", bot.id] as const,
      queryFn: () => botsApi.liveSummary(bot.id),
      retry: false,
    })),
  });
  const rows: BotListRow[] = active
    .map((bot, index): BotListRow => {
      const summary = summaries[index]?.data;
      return {
        bot,
        ...(summary ? { state: summary.state } : {}),
        ...(summary?.preview ? { preview: summary.preview } : {}),
        ...(summary?.updatedAt ? { updatedAt: summary.updatedAt } : {}),
      };
    })
    .sort((left, right) => (right.updatedAt ?? right.bot.updatedAt) - (left.updatedAt ?? left.bot.updatedAt));
  const [creating, setCreating] = React.useState(false);
  const [deleting, setDeleting] = React.useState<BotDefinition | null>(null);
  const openChat = (bot: BotDefinition) => void navigate(botChatPath(bot.id));

  return (
    <ScrollArea
      scrollRestorationId="bots-home"
      title="Bots"
      actions={
        <Button variant="toolbar" size="medium" onClick={() => setCreating(true)}>
          <Plus /> New Bot
        </Button>
      }
    >
      <main className="mx-auto w-full max-w-3xl px-5 pb-10 pt-4">
        <BotList
          rows={rows}
          loading={bots.isLoading}
          error={bots.isError}
          onRetry={() => void bots.refetch()}
          onOpen={openChat}
          onOpenProfile={(bot) => void navigate({ to: "/bots/$botId", params: { botId: bot.id } })}
          onDelete={setDeleting}
          onCreate={() => setCreating(true)}
          emptyState={<BotStarterCarousel onCreateOwn={() => setCreating(true)} onOpenChat={openChat} />}
        >
          <RemoteBots />
        </BotList>
      </main>
      <BotCreateFlow open={creating} onOpenChange={setCreating} onCreated={(bot) => openChat(bot)} />
      {deleting ? (
        <BotDeleteDialog
          bot={deleting}
          open
          onOpenChange={(open) => {
            if (!open) setDeleting(null);
          }}
        />
      ) : null}
    </ScrollArea>
  );
}

function BotPage({ botId }: { botId: string }) {
  const navigate = useNavigate();
  const bot = useBot(botId);
  // `?page=advanced` opens a sub-page directly (the chat's "Choose a model");
  // moving between Profile and its sub-pages after that is local.
  const initialPage = parseBotPageSearch(useSearch({ strict: false }) as Record<string, unknown>).page ?? null;
  const [page, setPage] = React.useState<BotSubpage | null>(initialPage);
  const [deleting, setDeleting] = React.useState(false);
  React.useEffect(() => setPage(initialPage), [botId, initialPage]);
  const openPage = setPage;
  const allBots = () => void navigate({ to: "/bots" });

  if (bot.isLoading) {
    return (
      <BotPageShell scrollId={`bot-profile:${botId}`} title="" backLabel="All Bots" onBack={allBots}>
        <BotPageSkeleton label="Loading Bot" groups={[3, 2]} />
      </BotPageShell>
    );
  }
  if (!bot.data) {
    return (
      <BotPageShell scrollId={`bot-profile:${botId}`} title="Bot" backLabel="All Bots" onBack={allBots}>
        <EmptyState
          title="Bot not found"
          description="This Bot may have been deleted."
          action={
            <Button variant="filled" onClick={allBots}>
              All Bots
            </Button>
          }
        />
      </BotPageShell>
    );
  }
  const current = bot.data;
  const back = () => openPage(null);
  return (
    <>
      {page === "instructions" ? (
        <BotInstructionsEditor key={`${current.id}:instructions`} bot={current} onClose={back} />
      ) : page === "advanced" ? (
        <BotAdvanced key={`${current.id}:advanced`} bot={current} onClose={back} />
      ) : page === "memory" ? (
        <BotMemoryPage key={`${current.id}:memory`} bot={current} onClose={back} />
      ) : (
        <BotProfile
          bot={current}
          onBack={allBots}
          onOpenChat={() => void navigate(botChatPath(current.id))}
          onOpenInstructions={() => openPage("instructions")}
          onOpenAdvanced={() => openPage("advanced")}
          onOpenMemory={() => openPage("memory")}
          onDelete={() => setDeleting(true)}
        />
      )}
      <BotDeleteDialog bot={current} open={deleting} onOpenChange={setDeleting} />
    </>
  );
}

/** Routes `/bots` to the Bots list, `/bots/$botId` to a Bot's Profile and `/bots/$botId/chat` to its chat. */
export function BotsView() {
  const params = useParams({ strict: false }) as { botId?: string };
  if (params.botId) return <BotPage botId={params.botId} />;
  return <BotsHome />;
}
