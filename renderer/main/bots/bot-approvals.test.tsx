import { emitBotTestNotification, installBotTestIpc } from "./test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useBotApprovals } from "./bot-approvals";

afterEach(cleanup);

function Waiting({ botId }: { botId: string | undefined }) {
  const { prompts } = useBotApprovals(botId);
  return <output aria-label="waiting">{prompts.map((prompt) => prompt.waitId).join(",")}</output>;
}

const shown = () => screen.getByLabelText("waiting").textContent;

test("approvals a Bot stopped listening for don't come back when it listens again", async () => {
  let pending = [
    {
      botId: "bot-1",
      waitId: "wait-1",
      toolCallId: "c1",
      toolName: "send_email",
      summary: "Email Sam.",
    },
  ];
  installBotTestIpc({ "bots:pendingApprovals": () => pending });
  const view = render(<Waiting botId="bot-1" />);
  await waitFor(() => assert.equal(shown(), "wait-1"));
  // Bubbled: the chat here stops listening, and the wait is answered in the bubble meanwhile.
  view.rerender(<Waiting botId={undefined} />);
  assert.equal(shown(), "");
  pending = [];
  view.rerender(<Waiting botId="bot-1" />);
  assert.equal(shown(), "", "the old card is not shown again");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  assert.equal(shown(), "");
  // New waits still arrive.
  act(() =>
    emitBotTestNotification("bots:approval", {
      botId: "bot-1",
      waitId: "wait-2",
      toolCallId: "c2",
      toolName: "x",
      summary: "y",
    }),
  );
  assert.equal(shown(), "wait-2");
});

test("switching to another Bot drops the first Bot's waiting approvals", async () => {
  installBotTestIpc({
    "bots:pendingApprovals": (botId) =>
      botId === "bot-1"
        ? [{ botId: "bot-1", waitId: "wait-1", toolCallId: "c1", toolName: "x", summary: "y" }]
        : [],
  });
  const view = render(<Waiting botId="bot-1" />);
  await waitFor(() => assert.equal(shown(), "wait-1"));
  view.rerender(<Waiting botId="bot-2" />);
  assert.equal(shown(), "");
});
