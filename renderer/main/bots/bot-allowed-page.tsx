import { Button, Callout, Field, FieldSet, Text } from "../../components/ui";
import { BotAllowedList } from "../../components/bots/bot-allowed-list";
import { botAlwaysAllowLabel } from "../../shared/tool-approval-scope";
import type { BotDefinition } from "../../shared/bots";
import { BotPageShell, BotPageSkeleton } from "./bot-page-shell";
import { useBotAllowed, useBotAllowedRemoval } from "./use-bot-allowed";

export function BotAllowedPage({ bot, onClose }: { bot: Pick<BotDefinition, "id" | "name">; onClose(): void }) {
  const allowed = useBotAllowed(bot.id);
  const { remove, removing, error } = useBotAllowedRemoval();
  return (
    <BotPageShell scrollId={`bot-allowed:${bot.id}`} title={bot.name} backLabel="Back" onBack={onClose} heading="Allowed without asking">
      {allowed.data === undefined && allowed.isPending ? <BotPageSkeleton label="Loading allowed actions" groups={[2]} /> : (
        <FieldSet>
          {allowed.data?.length ? <BotAllowedList entries={allowed.data} removing={removing?.entryId} onRemove={(entry) => void remove(entry)} /> : allowed.data ? (
            <Field description={`${bot.name} asks before changes in your apps and on websites. Choose ${botAlwaysAllowLabel(bot.name)} on a card to stop a question you keep answering.`} />
          ) : null}
        </FieldSet>
      )}
      {allowed.isError ? <Callout color="red" role="alert"><Text>Aiden couldn’t load these allowances.</Text><Button size="small" variant="filled" onClick={() => void allowed.refetch()}>Try again</Button></Callout> : null}
      {error ? <Callout color="red" role="alert">{error}</Callout> : null}
    </BotPageShell>
  );
}
