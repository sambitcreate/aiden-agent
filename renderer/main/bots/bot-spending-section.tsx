// A Bot's monthly spending limit on its Profile: the default from Settings,
// no limit, or an amount of its own, with what it spent this month.

import * as React from "react";
import { Field, FieldSet, toast } from "../../components/ui";
import { SpendingAmountSelect } from "../../components/spending/spending-amount-select";
import { spendingApi, type BotSpendingLimitChoice } from "../../lib/ipc";
import { useSettings } from "../../lib/queries";
import { useSpendingStatus } from "../../lib/use-spending-status";
import { formatUsd, ordinalDay, parseSpendingLimitsSettings } from "../../shared/spending";
import type { BotDefinition } from "../../shared/bots";

function choiceValue(choice: BotSpendingLimitChoice | undefined): string {
  if (choice === undefined || choice.kind === "default") return "default";
  return choice.kind === "none" ? "none" : String(choice.usd);
}

export function BotSpendingSection({ bot }: { bot: Pick<BotDefinition, "id" | "name"> }) {
  const settings = useSettings();
  const { status } = useSpendingStatus("bot", bot.id);
  const [choice, setChoice] = React.useState<BotSpendingLimitChoice | undefined>(undefined);
  React.useEffect(() => {
    let current = true;
    setChoice(undefined);
    void spendingApi.botLimit(bot.id).then(
      (next) => {
        if (current) setChoice(next);
      },
      () => undefined,
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
