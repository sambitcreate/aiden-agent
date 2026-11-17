import { isDeepStrictEqual } from "node:util";
import type { BotConnectorExecutionRestriction } from "../bot-connector-inventory-scope.js";
import type { BotRuntimeConnectionAuthority } from "../bot-runtime-authority.js";
import type { BotConnectorWatchBinding } from "../bot-routine-events/connector-types.js";
/** A saved account/resource never follows a later watch edit or credential incarnation. */
export function assertBotExecutionConnectorSource(botId: string, restriction: BotConnectorExecutionRestriction, fresh: { id: string; botId: string; enabled: boolean; updatedAt: number; connector?: { binding: BotConnectorWatchBinding } } | undefined, connection: BotRuntimeConnectionAuthority | undefined): void {
  if (!fresh?.enabled || fresh.botId !== botId || fresh.id !== restriction.routineId || fresh.updatedAt !== restriction.revision || !isDeepStrictEqual(fresh.connector?.binding, restriction.binding) || !isDeepStrictEqual(connection, restriction.binding.connection)) throw new Error("The accepted watch account or access changed. Review its source before resuming.");
}
