import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";
import { invalidateForBotsChanged } from "./bot-notifications-sync";
import { queryKeys } from "./queries";

function seeded(): QueryClient {
  const queryClient = new QueryClient();
  queryClient.setQueryData(queryKeys.botRoutines("bot-a"), [{ id: "morning", enabled: true }]);
  queryClient.setQueryData(queryKeys.botRoutines("bot-b"), [{ id: "evening", enabled: true }]);
  return queryClient;
}

const stale = (queryClient: QueryClient, botId: string) =>
  queryClient.getQueryState(queryKeys.botRoutines(botId))?.isInvalidated === true;

test("a routine change re-reads that Bot's Routines panel only", async () => {
  // What scheduled-bot-routines-main broadcasts when a Bot pauses a routine
  // or a phone accepts or edits one.
  const queryClient = seeded();
  await invalidateForBotsChanged(queryClient, { botId: "bot-a", routineId: "morning" });
  assert.equal(stale(queryClient, "bot-a"), true);
  assert.equal(stale(queryClient, "bot-b"), false);
});

test("a change naming no Bot re-reads every Routines panel", async () => {
  const queryClient = seeded();
  await invalidateForBotsChanged(queryClient, {});
  assert.equal(stale(queryClient, "bot-a"), true);
  assert.equal(stale(queryClient, "bot-b"), true);
});

test("a session state change leaves routines alone", async () => {
  const queryClient = seeded();
  await invalidateForBotsChanged(queryClient, { botId: "bot-a", session: { state: "working" } });
  assert.equal(stale(queryClient, "bot-a"), false);
});
