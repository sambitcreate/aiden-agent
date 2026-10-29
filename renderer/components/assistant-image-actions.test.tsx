import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { installBotTestIpc } from "../main/bots/test-dom";
import { MessageList } from "./message-list";
import type { ChatMessage } from "../lib/types";
import type { ChatArtifactV1 } from "../shared/chat-artifacts";

afterEach(cleanup);

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2aQAAAABJRU5ErkJggg==";
const image = { id: "img-1", name: "Generated image.png", mimeType: "image/png", kind: "image" as const, size: 68, data: PNG };

function settled(): ChatMessage[] {
  return [{ id: "assistant-1", role: "assistant", content: "Here it is.", createdAt: 1, attachments: [image] }];
}

function list(messages: ChatMessage[], artifacts: ChatArtifactV1[] = [], streamingText: string | null = null) {
  return (
    <MessageList
      chatId="chat-1"
      messages={messages}
      streamingText={streamingText}
      streamingReasoning={null}
      streamingArtifacts={artifacts}
      timeline={null}
      liveSubagents={[]}
      subagentsEnabled={false}
      onOpenSubagent={() => undefined}
      agentActivity={null}
      error={null}
    />
  );
}

const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

test("a settled generated image stands alone with its name, size and actions below it", async () => {
  const calls = installBotTestIpc({ "chats:saveImageToDownloads": () => ({ path: "/Users/me/Downloads/Generated image.png" }) });
  render(list(settled()));
  const figure = document.querySelector("[data-assistant-image='img-1']") as HTMLElement;
  assert.ok(figure);
  const open = within(figure).getByRole("button", { name: "Open Generated image.png preview" });
  assert.equal(open.querySelectorAll("svg").length, 0, "no control overlays the image");
  assert.ok(within(figure).getByText("Generated image.png · 68 B"));

  fireEvent.click(within(figure).getByRole("button", { name: "Save" }));
  await flush();
  assert.deepEqual(
    calls.filter((call) => call.channel.startsWith("chats:")),
    [{ channel: "chats:saveImageToDownloads", args: [{ chatId: "chat-1", attachmentId: "img-1" }] }],
  );

  fireEvent.click(within(figure).getByRole("button", { name: "Expand" }));
  const dialog = await screen.findByRole("dialog");
  assert.ok(within(dialog).getByRole("img", { name: "Generated image.png" }));
});

test("the caption's Copy button copies the stored image without a pointer menu", async () => {
  const calls = installBotTestIpc({ "chats:copyImage": () => true });
  render(list(settled()));
  const figure = document.querySelector("[data-assistant-image='img-1']") as HTMLElement;
  const buttons = within(figure).getAllByRole("button").map((button) => button.getAttribute("aria-label"));
  assert.deepEqual(buttons.slice(1), ["Expand", "Copy", "Save"]);
  fireEvent.click(within(figure).getByRole("button", { name: "Copy" }));
  await flush();
  assert.deepEqual(
    calls.filter((call) => call.channel.startsWith("chats:")),
    [{ channel: "chats:copyImage", args: [{ chatId: "chat-1", attachmentId: "img-1" }] }],
  );
});

test("a history image loads lazily into a box reserved from its header size", () => {
  installBotTestIpc();
  render(list(settled()));
  const img = screen.getByRole("img", { name: "Generated image.png" });
  assert.equal(img.getAttribute("loading"), "lazy");
  assert.equal(img.getAttribute("decoding"), "async");
  assert.deepEqual([img.getAttribute("width"), img.getAttribute("height")], ["1", "1"]);
  const box = screen.getByRole("button", { name: "Open Generated image.png preview" });
  assert.equal(box.style.aspectRatio.replace(/\s/gu, ""), "1/1");
});

test("right-click offers save, copy and the full view", async () => {
  const calls = installBotTestIpc({ "chats:copyImage": () => true });
  render(list(settled()));
  fireEvent.contextMenu(screen.getByRole("button", { name: "Open Generated image.png preview" }));
  const menu = await screen.findByRole("menu");
  assert.deepEqual(
    within(menu).getAllByRole("menuitem").map((item) => item.textContent),
    ["Save to Downloads", "Copy image", "Open full view"],
  );
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy image" }));
  await flush();
  assert.deepEqual(
    calls.filter((call) => call.channel.startsWith("chats:")),
    [{ channel: "chats:copyImage", args: [{ chatId: "chat-1", attachmentId: "img-1" }] }],
  );
});

test("an image still streaming in can be expanded but not yet saved", () => {
  installBotTestIpc();
  render(list([], [{ version: 1, kind: "image", attachment: image }], "Here it is."));
  const figure = document.querySelector("[data-assistant-image='img-1']") as HTMLElement;
  assert.ok(within(figure).getByRole("button", { name: "Expand" }));
  assert.equal(within(figure).queryByRole("button", { name: "Save" }), null);
  assert.equal(within(figure).queryByRole("button", { name: "Copy" }), null);
});
