import * as React from "react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { Plus, RotateCcw } from "lucide-react";
import { Button, Callout, EmptyState, ScrollArea, Text } from "../components/ui";
import { botChatPath } from "../lib/bot-routes";
import { lastViewedBotId } from "../lib/bot-sidebar-preferences";
import { useBot } from "../lib/queries";
import type { BotDefinition } from "../shared/bots";
import { BotAdvanced } from "./bots/bot-advanced";
import { BotChatActivityPage } from "./bots/bot-chat-activity-page";
import { BotInterruptionsPage } from "./bots/bot-interruptions-page";
import { BotCreateFlow } from "./bots/bot-create-flow";
import { BotDeleteDialog } from "./bots/bot-delete-dialog";
import { BotInstructionsEditor } from "./bots/bot-instructions-editor";
import { useBotRows } from "./bots/bot-sidebar-rows";
import { BotMemoryPage } from "./bots/bot-memory-page";
import { BotPageShell, BotPageSkeleton } from "./bots/bot-page-shell";
import { parseBotPageSearch, type BotSubpage } from "./bots/bot-page-search";
import { BotProfile } from "./bots/bot-profile";
import { BotStarterCarousel } from "./bots/bot-starter-carousel";
import { useBotSidebarPreferences } from "./bots/use-bot-sidebar-preferences";

/** How long /bots waits for chat-activity summaries before ordering Bots by their own updatedAt. */
const SUMMARIES_GRACE_MS = 800;
/** How recent a cached Bots list must be for /bots to open the last viewed Bot from it while it refreshes. */
const CACHED_LIST_TRUST_MS = 5 * 60 * 1000;

/**
 * `/bots` with no Bot selected (spec §9): the Bot list lives in the sidebar, so
 * this opens the chat of the Bot last viewed on this Mac, else the one with the
 * newest activity. With no Bots it is "Meet your first Bot".
 */
function BotsIndex() {
  const navigate = useNavigate();
  const { bots, rows, summariesSettled } = useBotRows();
  const { preferences } = useBotSidebarPreferences();
  const [creating, setCreating] = React.useState(false);
  const [summariesGraceOver, setSummariesGraceOver] = React.useState(false);
  const openChat = (bot: BotDefinition) => void navigate(botChatPath(bot.id));
  // A settled, successful load names a Bot to open. A list read recently enough
  // (this launch's own read, refreshing in the background) may name the Bot the
  // person last looked at without waiting: that Bot's chat shows at once from
  // the cache, and a Bot deleted elsewhere since would say so on its page.
  const settled = bots.isSuccess && !bots.isFetching;
  const freshEnough = bots.isSuccess && Date.now() - bots.dataUpdatedAt < CACHED_LIST_TRUST_MS;
  const hasBots = bots.isSuccess && bots.data.length > 0;
  const target = React.useMemo(() => {
    if (bots.data === undefined || bots.data.length === 0) return null;
    const viewed = lastViewedBotId(preferences, new Set(bots.data.map((bot) => bot.id)));
    if (viewed && (settled || freshEnough)) return viewed;
    if (!settled) return null;
    // Rows are ordered by chat activity once the summaries are in, else by the Bot's own
    // updatedAt; a summary that never answers must not keep /bots blank.
    return summariesSettled || summariesGraceOver ? (rows[0]?.bot.id ?? null) : null;
  }, [bots.data, freshEnough, preferences, rows, settled, summariesGraceOver, summariesSettled]);

  React.useEffect(() => {
    if (!settled || summariesSettled) return;
    const timer = setTimeout(() => setSummariesGraceOver(true), SUMMARIES_GRACE_MS);
    return () => clearTimeout(timer);
  }, [settled, summariesSettled]);

  React.useEffect(() => {
    // While the create flow is open it finishes first and opens the new Bot itself.
    if (target && !creating) void navigate({ ...botChatPath(target), replace: true });
  }, [creating, navigate, target]);

  if (hasBots && !creating) {
    return (
      <main className="mx-auto h-full w-full max-w-3xl px-5 pt-4">
        <BotPageSkeleton label="Opening your Bot" groups={[3]} />
      </main>
    );
  }
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
        {bots.isError ? (
          <Callout color="red" role="alert" className="flex-row items-center justify-between gap-4">
            <div>
              <Text variant="small-strong" color="red">
                Your Bots couldn’t be loaded
              </Text>
              <Text as="p" variant="small" color="secondary" className="mt-0.5">
                Check that Aiden finished starting, then try again.
              </Text>
            </div>
            <Button size="small" variant="filled" onClick={() => void bots.refetch()}>
              <RotateCcw /> Try again
            </Button>
          </Callout>
        ) : bots.isLoading ? (
          <BotPageSkeleton label="Loading Bots" groups={[3]} />
        ) : (
          <BotStarterCarousel onCreateOwn={() => setCreating(true)} onOpenChat={openChat} />
        )}
      </main>
      <BotCreateFlow open={creating} onOpenChange={setCreating} onCreated={(bot) => openChat(bot)} />
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
        <BotAdvanced
          key={`${current.id}:advanced`}
          bot={current}
          onClose={back}
          onOpenChatActivity={() => openPage("chat-activity")}
          onOpenInterruptions={() => openPage("interruptions")}
        />
      ) : page === "interruptions" ? (
        <BotInterruptionsPage key={`${current.id}:interruptions`} bot={current} onClose={() => openPage("advanced")} />
      ) : page === "chat-activity" ? (
        <BotChatActivityPage key={`${current.id}:chat-activity`} bot={current} onClose={() => openPage("advanced")} />
      ) : page === "memory" ? (
        <BotMemoryPage key={`${current.id}:memory`} bot={current} onClose={back} />
      ) : (
        <BotProfile
          bot={current}
          onBack={() => void navigate(botChatPath(current.id))}
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

/** Routes `/bots` to the most recent Bot's chat (or the starter Bots), `/bots/$botId` to a Bot's Profile and `/bots/$botId/chat` to its chat. */
export function BotsView() {
  const params = useParams({ strict: false }) as { botId?: string };
  if (params.botId) return <BotPage botId={params.botId} />;
  return <BotsIndex />;
}
