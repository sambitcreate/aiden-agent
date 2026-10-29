import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatFindBar } from "./chat-find-bar";
import { ScrollArea } from "./ui";
import { chatFindStatus, findChatMatches } from "../lib/chat-find";

afterEach(cleanup);

function Conversation({ extra = [] as string[], onClose = () => {} }) {
  return (
    <ScrollArea focusRegion="chat" overlay={<ChatFindBar request={1} onClose={onClose} />}>
      <p>The release ships on Friday.</p>
      <p>
        Friday works, but <strong>release</strong> notes come first.
      </p>
      <p aria-hidden="true">release (hidden copy)</p>
      {extra.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </ScrollArea>
  );
}

const status = () => screen.getByRole("status").textContent;
const search = () => screen.getByRole("searchbox", { name: "Find in chat" });

test("matches ignore case and skip text a reader can't see", () => {
  const root = document.createElement("div");
  root.innerHTML = "<p>Release notes</p><p hidden>release</p><p aria-hidden='true'>release</p><p>pre-RELEASE build, release day</p>";
  const matches = findChatMatches(root, "release");
  assert.deepEqual(
    matches.map((range) => range.toString()),
    ["Release", "RELEASE", "release"],
  );
  assert.equal(findChatMatches(root, "   ").length, 0, "spaces alone find nothing");
  // Lowercasing İ adds a combining dot; matches still cover the original text.
  const dotted = document.createElement("div");
  dotted.textContent = "İx and İ";
  assert.deepEqual(findChatMatches(dotted, "x").map(String), ["x"]);
  assert.deepEqual(findChatMatches(dotted, "İ").map(String), ["İ", "İ"]);
  // A capital sigma lowercases by context (ς at a word's end), so the same word
  // must still match in a node with other text, whichever sigma is typed.
  const greek = document.createElement("div");
  greek.textContent = "İ ΟΣ";
  assert.deepEqual(findChatMatches(greek, "ΟΣ").map(String), ["ΟΣ"]);
  assert.deepEqual(findChatMatches(greek, "ος").map(String), ["ΟΣ"]);
  assert.equal(findChatMatches(root, "release", 2).length, 2, "stops at the limit");
});

test("the count reads plainly, and says when it stopped counting", () => {
  assert.equal(chatFindStatus(0, 0), "No matches");
  assert.equal(chatFindStatus(12, 2), "3 of 12");
  assert.equal(chatFindStatus(1000, 0, 1000), "1 of 1,000+");
});

test("⌘F's bar takes focus, counts matches in the conversation, and ↩ / ⇧↩ step through them", async () => {
  render(<Conversation />);
  assert.equal(document.activeElement, search());
  fireEvent.change(search(), { target: { value: "release" } });
  await waitFor(() => assert.equal(status(), "1 of 2"));
  fireEvent.keyDown(search(), { key: "Enter" });
  assert.equal(status(), "2 of 2");
  fireEvent.keyDown(search(), { key: "Enter" });
  assert.equal(status(), "1 of 2", "wraps around");
  fireEvent.keyDown(search(), { key: "Enter", shiftKey: true });
  assert.equal(status(), "2 of 2");
  fireEvent.click(screen.getByRole("button", { name: "Next match" }));
  assert.equal(status(), "1 of 2");
  fireEvent.change(search(), { target: { value: "tuesday" } });
  await waitFor(() => assert.equal(status(), "No matches"));
  assert.equal(screen.getByRole("button", { name: "Next match" }).hasAttribute("disabled"), true);
});

test("a reply that arrives while the bar is open is counted too", async () => {
  const { rerender } = render(<Conversation />);
  fireEvent.change(search(), { target: { value: "friday" } });
  await waitFor(() => assert.equal(status(), "1 of 2"));
  rerender(<Conversation extra={["See you Friday."]} />);
  await waitFor(() => assert.equal(status(), "1 of 3"));
});

test("a reply that keeps streaming faster than the refresh delay is still counted as it grows", async () => {
  const lines: string[] = [];
  const { rerender } = render(<Conversation />);
  fireEvent.change(search(), { target: { value: "friday" } });
  await waitFor(() => assert.equal(status(), "1 of 2"));
  // A new matching line every 25 ms; the bar must catch up before the stream stops.
  let counted = false;
  for (let line = 0; line < 20 && !counted; line += 1) {
    lines.push(`Friday line ${line}`);
    rerender(<Conversation extra={[...lines]} />);
    await act(() => new Promise((resolve) => setTimeout(resolve, 25)));
    counted = status() !== "1 of 2";
  }
  assert.ok(counted, "the count moved while the reply was still streaming");
});

test("Esc closes the bar and gives focus back to what had it", async () => {
  let closed = 0;
  function Host() {
    const [open, setOpen] = React.useState(false);
    return (
      <>
        <textarea aria-label="Message" />
        <button type="button" onClick={() => setOpen(true)}>
          Find
        </button>
        {open ? (
          <ScrollArea
            overlay={
              <ChatFindBar
                request={1}
                onClose={() => {
                  closed += 1;
                  setOpen(false);
                }}
              />
            }
          >
            <p>Hello</p>
          </ScrollArea>
        ) : null}
      </>
    );
  }
  render(<Host />);
  const message = screen.getByRole("textbox", { name: "Message" });
  message.focus();
  // As ⌘F from the message box: the bar opens while the message box has focus.
  act(() => {
    screen.getByRole("button", { name: "Find" }).click();
    message.focus();
  });
  await waitFor(() => assert.equal(document.activeElement, search()));
  fireEvent.keyDown(search(), { key: "Escape" });
  assert.equal(closed, 1);
  assert.equal(screen.queryByRole("search"), null);
  assert.equal(document.activeElement, message);
});
