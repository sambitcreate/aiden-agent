import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { BotConnectorWatchSourceList } from "../shared/bot-connector-watches";
import type { ScheduledTaskConnectorTrigger } from "../shared/scheduled-task-trigger";
import {
  ConnectorTriggerFields,
  connectorTriggerReady,
  newConnectorTrigger,
} from "./scheduled-task-editor";

afterEach(() => cleanup());

const SOURCES: BotConnectorWatchSourceList = {
  choices: [
    {
      id: "4c9f5a3e-1d2b-4f6a-9b8c-7d6e5f4a3b2c",
      templateId: "mail_messages",
      providerLabel: "iMCP Mail",
      accountLabel: "me@example.test",
      resourceLabel: "Inbox",
      available: true,
    },
    {
      id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      templateId: "calendar_upcoming",
      providerLabel: "Composio Calendar",
      accountLabel: "Work",
      resourceLabel: "Team",
      available: true,
    },
  ],
  unavailableReasons: ["Composio isn't connected yet."],
};

function Harness({
  initial,
  savedKind,
  findSources,
  onTrigger,
}: {
  initial: ScheduledTaskConnectorTrigger;
  savedKind?: "email" | "calendar";
  findSources: () => Promise<BotConnectorWatchSourceList>;
  onTrigger: (trigger: ScheduledTaskConnectorTrigger) => void;
}) {
  const [trigger, setTrigger] = React.useState(initial);
  return (
    <ConnectorTriggerFields
      trigger={trigger}
      savedKind={savedKind}
      findSources={findSources}
      onChange={(next) => {
        setTrigger(next);
        onTrigger(next);
      }}
    />
  );
}

test("nothing is listed until Find sources; a picked mailbox becomes the task's choice and it can be saved", async () => {
  let listed = 0;
  let latest = newConnectorTrigger();
  render(
    <Harness
      initial={latest}
      findSources={async () => {
        listed += 1;
        return SOURCES;
      }}
      onTrigger={(next) => {
        latest = next;
      }}
    />,
  );
  assert.equal(listed, 0, "opening the editor lists nothing");
  assert.ok(screen.getByText("Not chosen yet."));
  assert.equal(
    connectorTriggerReady(latest, undefined),
    false,
    "a new task can't be saved without a source",
  );

  fireEvent.click(screen.getByRole("button", { name: "Find sources" }));
  fireEvent.click(await screen.findByRole("combobox", { name: "Connected source" }));
  assert.equal(
    screen.queryByRole("option", { name: /Composio Calendar/u }),
    null,
    "only mailboxes are offered for mail",
  );
  fireEvent.click(
    await screen.findByRole("option", { name: "iMCP Mail · me@example.test · Inbox" }),
  );
  assert.equal(listed, 1);
  assert.ok(screen.getByText("Composio isn't connected yet."));
  assert.equal(latest.sourceChoiceId, SOURCES.choices[0]!.id);
  assert.equal(latest.source.resourceLabel, "Inbox");
  assert.equal(connectorTriggerReady(latest, undefined), true);
});

test("an edit keeps the saved source until the watch switches between mail and calendar", () => {
  const saved: ScheduledTaskConnectorTrigger = {
    ...newConnectorTrigger(),
    source: { providerLabel: "iMCP Mail", accountLabel: "me@example.test", resourceLabel: "Inbox" },
  };
  let latest = saved;
  render(
    <Harness
      initial={saved}
      savedKind="email"
      findSources={async () => SOURCES}
      onTrigger={(next) => {
        latest = next;
      }}
    />,
  );
  assert.ok(screen.getByText("iMCP Mail · me@example.test · Inbox"));
  assert.ok(screen.getByRole("button", { name: "Find a different source" }));
  assert.equal(connectorTriggerReady(latest, saved), true);

  fireEvent.change(screen.getByLabelText("Sender contains"), { target: { value: "billing@" } });
  assert.deepEqual(latest.condition, { kind: "email", unreadOnly: false, sender: "billing@" });
  assert.equal(connectorTriggerReady(latest, saved), true, "changing a filter keeps the source");

  fireEvent.click(screen.getByRole("combobox", { name: "What the task watches" }));
  fireEvent.click(screen.getByRole("option", { name: "Upcoming calendar events" }));
  assert.equal(latest.condition.kind, "calendar");
  assert.equal(connectorTriggerReady(latest, saved), false, "a calendar needs its own source");
  assert.ok(screen.getByText("Not chosen yet."));
});

test("a calendar watch needs a look-ahead window between 15 minutes and a day", () => {
  const calendar = { ...newConnectorTrigger("calendar"), sourceChoiceId: SOURCES.choices[1]!.id };
  assert.equal(connectorTriggerReady(calendar, undefined), true);
  assert.equal(
    connectorTriggerReady(
      {
        ...calendar,
        condition: { ...calendar.condition, lookAheadMinutes: 5 } as typeof calendar.condition,
      },
      undefined,
    ),
    false,
  );
  assert.equal(
    connectorTriggerReady(
      {
        ...calendar,
        condition: { ...calendar.condition, lookAheadMinutes: 2_000 } as typeof calendar.condition,
      },
      undefined,
    ),
    false,
  );
});
