import * as React from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { EmptyState, Text, toast } from "../components/ui";
import { botsApi, onNotification } from "../lib/ipc";
import { useBot, useBots } from "../lib/queries";
import type { BotDefinition } from "../shared/bots";
import { BotAdvanced } from "./bots/bot-advanced";
import { BotCreateFlow } from "./bots/bot-create-flow";
import { BotDeleteDialog } from "./bots/bot-delete-dialog";
import { BotInstructionsEditor } from "./bots/bot-instructions-editor";
import { BotList, type BotListRow } from "./bots/bot-list";
import { BotProfile } from "./bots/bot-profile";
import { BotStarterCarousel } from "./bots/bot-starter-carousel";
import { useConnectionSetup } from "./bots/use-connection-setup";
import { RemoteBots } from "./remote-bots";

/** The Bot's one conversation, addressed by Bot id only. */
export function botChatPath(botId: string): { to: "/bots/$botId/chat"; params: { botId: string } } {
  return { to: "/bots/$botId/chat", params: { botId } };
}

function BotsHome() {
  const navigate = useNavigate();
  const qc = useQueryClient();
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
  const connectionSetup = useConnectionSetup(() => {
    void qc.invalidateQueries({ queryKey: ["bot-live-summary"] });
  });
  const openSetup = connectionSetup.open;

  // A Bot connection requested elsewhere (a paired phone, a connect card) opens its setup here.
  React.useEffect(
    () =>
      onNotification("bots:connections:setup", (payload: { pluginId: string }) => {
        if (!openSetup(payload.pluginId)) {
          toast.error("This connection can't be set up from here.");
        }
      }),
    [openSetup],
  );

  return (
    <>
      <BotList
        rows={rows}
        loading={bots.isLoading}
        error={bots.isError}
        onRetry={() => void bots.refetch()}
        onOpen={openChat}
        onOpenProfile={(bot) => void navigate({ to: "/bots/$botId", params: { botId: bot.id } })}
        onDelete={setDeleting}
        onCreate={() => setCreating(true)}
        emptyState={
          <BotStarterCarousel onCreateOwn={() => setCreating(true)} onOpenChat={openChat} />
        }
      >
        <RemoteBots />
      </BotList>
      <BotCreateFlow
        open={creating}
        onOpenChange={setCreating}
        onCreated={(bot) => openChat(bot)}
      />
      {deleting ? (
        <BotDeleteDialog
          bot={deleting}
          open
          onOpenChange={(open) => {
            if (!open) setDeleting(null);
          }}
        />
      ) : null}
      {connectionSetup.dialog}
    </>
  );
}

type ProfilePage = "profile" | "instructions" | "advanced";

function BotPage({ botId }: { botId: string }) {
  const navigate = useNavigate();
  const bot = useBot(botId);
  const [page, setPage] = React.useState<ProfilePage>("profile");
  const [deleting, setDeleting] = React.useState(false);
  React.useEffect(() => setPage("profile"), [botId]);

  if (bot.isLoading) return <Text color="secondary">Loading…</Text>;
  if (!bot.data) {
    return <EmptyState title="Bot not found" description="This Bot may have been deleted." />;
  }
  const current = bot.data;
  const back = () => setPage("profile");
  return (
    <>
      {page === "instructions" ? (
        <BotInstructionsEditor bot={current} onClose={back} />
      ) : page === "advanced" ? (
        <BotAdvanced bot={current} onClose={back} />
      ) : (
        <BotProfile
          bot={current}
          onBack={() => void navigate({ to: "/bots" })}
          onOpenChat={() => void navigate(botChatPath(current.id))}
          onOpenInstructions={() => setPage("instructions")}
          onOpenAdvanced={() => setPage("advanced")}
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
  if (params.botId) {
    return <BotPage botId={params.botId} />;
  }
  return (
    <div className="h-full overflow-y-auto">
      <main className="mx-auto w-full max-w-3xl px-8 pb-16 pt-16 max-[640px]:px-5">
        <BotsHome />
      </main>
    </div>
  );
}
