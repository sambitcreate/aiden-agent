// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { emitBotTestNotification, installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { consumePendingDesignEntry } from "../lib/design-mode";
import { DesignModeConsentCard, resetDesignModeConsentForTests, useDesignModeConsent } from "./design-mode-consent";

afterEach(() => {
  cleanup();
  resetDesignModeConsentForTests();
});

function ChatSlot({ chatId }: { chatId: string }) {
  const request = useDesignModeConsent(chatId);
  return request ? <DesignModeConsentCard key={request.requestId} request={request} /> : <p>No card</p>;
}

function ask(requestId: string, chatId = "chat-1", reason = "Comparing three directions is easier side by side.") {
  act(() => emitBotTestNotification("designCanvas:consent", { requestId, chatId, reason }));
}

test("Aiden's card shows its reason in the chat it asked about, and nowhere else", async () => {
  installBotTestIpc();
  render(
    <>
      <ChatSlot chatId="chat-1" />
      <ChatSlot chatId="chat-2" />
    </>,
  );
  ask("r1");
  const card = await screen.findByRole("group", { name: "Aiden asks to open design mode" });
  assert.ok(card.textContent?.includes("Comparing three directions is easier side by side."));
  assert.equal(screen.getAllByText("No card").length, 1, "the other chat shows no card");
});

test("Enter design mode answers enter and makes room for the canvas; the card goes away", async () => {
  const calls = installBotTestIpc({ "designCanvas:consentAnswer": () => true });
  render(<ChatSlot chatId="chat-1" />);
  ask("r1");
  fireEvent.click(await screen.findByRole("button", { name: "Enter design mode" }));
  await waitFor(() => assert.ok(screen.getByText("No card")));
  assert.deepEqual(
    calls.filter((call) => call.channel === "designCanvas:consentAnswer").map((call) => call.args),
    [["r1", "enter"]],
  );
  assert.equal(consumePendingDesignEntry("chat-1"), "card", "the layout makes room as for the Design toggle");
});

test("Not now answers decline and leaves the layout alone", async () => {
  const calls = installBotTestIpc({ "designCanvas:consentAnswer": () => true });
  render(<ChatSlot chatId="chat-1" />);
  ask("r1");
  fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
  await waitFor(() => assert.ok(screen.getByText("No card")));
  assert.deepEqual(
    calls.filter((call) => call.channel === "designCanvas:consentAnswer").map((call) => call.args),
    [["r1", "decline"]],
  );
  assert.equal(consumePendingDesignEntry("chat-1"), null);
});

test("the card closes when Aiden stops waiting, and a late Enter does not make room", async () => {
  installBotTestIpc({ "designCanvas:consentAnswer": () => false });
  render(<ChatSlot chatId="chat-1" />);
  ask("r1");
  await screen.findByRole("group", { name: "Aiden asks to open design mode" });
  act(() => emitBotTestNotification("designCanvas:consentClosed", { requestId: "other" }));
  assert.ok(screen.getByRole("group", { name: "Aiden asks to open design mode" }), "another card's close is not ours");
  act(() => emitBotTestNotification("designCanvas:consentClosed", { requestId: "r1" }));
  assert.ok(screen.getByText("No card"));

  // A card that expired between showing and the click.
  ask("r2");
  fireEvent.click(await screen.findByRole("button", { name: "Enter design mode" }));
  await waitFor(() => assert.ok(screen.getByText("No card")));
  assert.equal(consumePendingDesignEntry("chat-1"), null);
});
