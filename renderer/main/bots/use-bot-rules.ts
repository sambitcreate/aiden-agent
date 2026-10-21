// A Bot's rules, as Profile → Rules reads and changes them. Each change names
// the revision of the view it was made from; main refuses a stale or invalid
// change with the current view, which replaces the cached one either way.

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { botsApi } from "../../lib/ipc";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import { botRuleRefusalText, type BotRuleChange, type BotRulesView } from "../../shared/bot-rules";

export const botRulesKey = (botId: string) => ["bot-rules", botId] as const;

export function useBotRules(botId: string) {
  return useQuery({
    queryKey: botRulesKey(botId),
    queryFn: () => botsApi.rules.get(botId),
  });
}

/** `null` when the change was saved, or what to tell the person. */
export type BotRuleChangeOutcome = string | null;

/** Sends one change at a time against the cached view's revision. */
export function useBotRuleChange(botId: string) {
  const qc = useQueryClient();
  const [busy, setBusy] = React.useState(false);
  const inFlight = React.useRef(false);

  const apply = React.useCallback(
    async (change: BotRuleChange): Promise<BotRuleChangeOutcome> => {
      if (inFlight.current) return "Aiden is still saving the last change.";
      const current = qc.getQueryData<BotRulesView>(botRulesKey(botId));
      if (!current) return "Aiden is still loading these rules.";
      inFlight.current = true;
      setBusy(true);
      try {
        const result = await botsApi.rules.update({ botId, revision: current.revision, change });
        qc.setQueryData(botRulesKey(botId), result.view);
        return result.ok ? null : botRuleRefusalText(result.reason);
      } catch (caught) {
        return userFacingErrorMessage(caught, "Aiden couldn’t save this rule.");
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [botId, qc],
  );

  return { apply, busy };
}
