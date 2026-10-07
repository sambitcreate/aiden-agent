import { installBotTestIpc } from "./test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { BotDeleteDialog } from "./bot-delete-dialog";
import { mountWithBotRouter } from "./test-providers";

afterEach(cleanup);

const bot = { id: "bot-1", name: "Chief", revision: "rev-7" };

async function openDialog() {
  const harness = await mountWithBotRouter(
    <BotDeleteDialog bot={bot} open onOpenChange={() => undefined} />,
    { initialPath: "/bots/bot-1" },
  );
  return { ...harness, dialog: await screen.findByRole("alertdialog") };
}

test("the delete confirmation warns exactly what is erased", async () => {
  installBotTestIpc();
  const { dialog } = await openDialog();
  assert.ok(within(dialog).getByRole("heading", { name: "Delete Chief?" }));
  assert.ok(
    within(dialog).getByText(
      "This permanently erases Chief's chat, memory, instructions, routines, files, and photo. This can't be undone.",
    ),
  );
  assert.ok(within(dialog).getByRole("button", { name: "Delete Bot" }));
});

test("confirming calls bots:delete and returns to the Bots list", async () => {
  const calls = installBotTestIpc({ "bots:delete": () => undefined, "bots:list": () => [] });
  const { dialog, router } = await openDialog();
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete Bot" }));
  await waitFor(() => assert.equal(router.state.location.pathname, "/bots"));
  assert.deepEqual(
    calls.filter((call) => call.channel.startsWith("bots:") && call.channel !== "bots:getCanonicalPhoto")[0],
    { channel: "bots:delete", args: [{ id: "bot-1" }] },
  );
});

test("until the runtime registers bots:delete, the Bot is archived instead", async () => {
  const calls = installBotTestIpc({ "bots:archive": () => ({}), "bots:list": () => [] });
  const { dialog, router } = await openDialog();
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete Bot" }));
  await waitFor(() => assert.equal(router.state.location.pathname, "/bots"));
  assert.deepEqual(
    calls.find((call) => call.channel === "bots:archive")?.args,
    [{ id: "bot-1", expectedRevision: "rev-7" }],
  );
});

test("a failed delete keeps the dialog open and the Bot in place", async () => {
  installBotTestIpc({
    "bots:delete": () => {
      throw new Error("Error invoking remote method 'bots:delete': Error: This Bot is busy.");
    },
  });
  const { dialog, router } = await openDialog();
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete Bot" }));
  await waitFor(() =>
    assert.equal(
      (within(dialog).getByRole("button", { name: "Delete Bot" }) as HTMLButtonElement).disabled,
      false,
    ),
  );
  assert.equal(router.state.location.pathname, "/bots/bot-1");
  assert.ok(screen.getByRole("alertdialog"));
});
