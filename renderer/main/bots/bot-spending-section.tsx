// A Bot's monthly spending limit on its Profile: the default from Settings,
// no limit, or an amount of its own, with what it spent this month. It is an
// override of the Mac's limits, so like them it shows only once a provider
// bills by the request, or while the Bot or the Mac already has a limit.

import * as React from "react";
import { Field, FieldSet, toast } from "../../components/ui";
import { SpendingAmountSelect } from "../../components/spending/spending-amount-select";
import { spendingApi, type BotSpendingLimitChoice } from "../../lib/ipc";
import { useProviders, useSettings } from "../../lib/queries";
import { useSpendingStatus } from "../../lib/use-spending-status";
import {
  anySpendingLimitSet,
  formatUsd,
  meteredProviderConnected,
  ordinalDay,
  parseSpendingLimitsSettings,
} from "../../shared/spending";
import type { BotDefinition } from "../../shared/bots";

function choiceValue(choice: BotSpendingLimitChoice | undefined): string {
  if (choice === undefined || choice.kind === "default") return "default";
  return choice.kind === "none" ? "none" : String(choice.usd);
}

export function BotSpendingSection({ bot }: { bot: Pick<BotDefinition, "id" | "name"> }) {
  const settings = useSettings();
  const providers = useProviders();
  const { status } = useSpendingStatus("bot", bot.id);
  const [choice, setChoice] = React.useState<BotSpendingLimitChoice | undefined>(undefined);
  /** The Bot's own limit couldn't be read: it may be the one set. */
  const [unread, setUnread] = React.useState(false);
  React.useEffect(() => {
    let current = true;
    setChoice(undefined);
    setUnread(false);
    void spendingApi.botLimit(bot.id).then(
      (next) => {
        if (current) setChoice(next);
      },
      () => {
        if (current) setUnread(true);
      },
    );
    return () => {
      current = false;
    };
  }, [bot.id]);
  const defaults = parseSpendingLimitsSettings(settings.data?.spendingLimits) ?? {};
  const defaultLabel = `Default (${defaults.botMonthUsd === undefined ? "no limit" : formatUsd(defaults.botMonthUsd)})`;
  const startDay = ordinalDay(defaults.monthStartDay ?? 1);
  const spent = status ? `${formatUsd(status.spentUsd)} spent this month.` : "";

  const change = async (value: string) => {
    const previous = choice;
    const next: BotSpendingLimitChoice =
      value === "default" ? { kind: "default" } : value === "none" ? { kind: "none" } : { kind: "amount", usd: Number(value) };
    setChoice(next);
    try {
      setChoice(await spendingApi.setBotLimit(bot.id, next.kind === "default" ? "default" : next.kind === "none" ? null : next.usd));
    } catch {
      setChoice(previous);
      toast.error(`Couldn’t change ${bot.name}’s spending limit.`);
    }
  };

  // Shown once something here can cost money, and whenever a limit might be
  // set but can't be read, so a hidden section never hides a limit.
  const shown =
    providers.isError ||
    settings.isError ||
    unread ||
    meteredProviderConnected(providers.data ?? []) ||
    anySpendingLimitSet(defaults) ||
    (choice !== undefined && choice.kind !== "default") ||
    status !== undefined;
  if (!shown) return null;

  return (
    <FieldSet title="Spending">
      <Field
        label="Monthly limit"
        description={`${spent ? `${spent} ` : ""}The month starts over on the ${startDay}. Routines count too.`}
      >
        <SpendingAmountSelect
          label={`${bot.name}’s monthly spending limit`}
          value={choiceValue(choice)}
          disabled={choice === undefined}
          extraOptions={[{ value: "default", label: defaultLabel }]}
          onChange={(value) => void change(value)}
        />
      </Field>
    </FieldSet>
  );
}
