import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MessageList } from "./message-list";
import type { ChatMessage } from "../lib/types";
import type { ProviderFailureAction, ProviderFailureCategoryV1 } from "../shared/provider-failure";

afterEach(() => cleanup());

function failed(id: string, category: ProviderFailureCategoryV1): ChatMessage {
  return {
    id,
    role: "assistant",
    content: "",
    createdAt: 2,
    providerFailure: { version: 1, category, attempts: 1, retryExhausted: false },
  };
}

function renderList(messages: ChatMessage[], failureActions?: Parameters<typeof MessageList>[0]["failureActions"]) {
  return render(
    <MessageList
      chatId="chat-1"
      messages={messages}
      streamingText={null}
      streamingReasoning={null}
      timeline={null}
      liveSubagents={[]}
      subagentsEnabled={false}
      onOpenSubagent={() => undefined}
      agentActivity={null}
      error={null}
      failureActions={failureActions}
    />,
  );
}

const user: ChatMessage = { id: "user-1", role: "user", content: "Do the thing", createdAt: 1 };

for (const [category, label, action] of [
  ["network", "Try again", "try_again"],
  ["timeout", "Try again", "try_again"],
  ["authentication", "Open Providers", "open_providers"],
  ["quota", "Open Providers", "open_providers"],
  ["output_limit", "Continue", "continue"],
  ["context_window", "Compact and try again", "compact"],
] as const satisfies ReadonlyArray<readonly [ProviderFailureCategoryV1, string, ProviderFailureAction]>) {
  test(`a ${category} failure offers ${label} on the latest failed reply`, () => {
    const chosen: ProviderFailureAction[] = [];
    let switched = 0;
    renderList([user, failed("reply-1", category)], {
      messageId: "reply-1",
      onAction: (next) => chosen.push(next),
      onSwitchModel: () => {
        switched += 1;
      },
    });
    fireEvent.click(screen.getByRole("button", { name: label }));
    fireEvent.click(screen.getByRole("button", { name: "Switch model" }));
    assert.deepEqual(chosen, [action]);
    assert.equal(switched, 1);
  });
}

test("an older failure card and a card without actions show no buttons", () => {
  renderList(
    [user, failed("reply-old", "network"), { ...user, id: "user-2" }, failed("reply-new", "network")],
    { messageId: "reply-new", onAction: () => undefined },
  );
  const cards = screen.getAllByRole("alert");
  assert.equal(cards.length, 2);
  assert.equal(cards[0]!.querySelectorAll("button").length, 0);
  assert.equal(cards[1]!.querySelectorAll("button").length, 1);
  cleanup();
  renderList([user, failed("reply-1", "network")]);
  assert.equal(screen.getByRole("alert").querySelectorAll("button").length, 0);
});

test("buttons wait while an action runs", () => {
  renderList([user, failed("reply-1", "network")], {
    messageId: "reply-1",
    busy: true,
    onAction: () => assert.fail("a busy card must not run another action"),
    onSwitchModel: () => undefined,
  });
  const tryAgain = screen.getByRole("button", { name: "Try again" }) as HTMLButtonElement;
  assert.equal(tryAgain.disabled, true);
  fireEvent.click(tryAgain);
});
