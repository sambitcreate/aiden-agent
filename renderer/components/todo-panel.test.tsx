import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TodoPanel } from "./todo-panel.js";

const source = readFileSync(new URL("./todo-panel.tsx", import.meta.url), "utf8");
const chatPaneSource = readFileSync(new URL("../main/chat-pane.tsx", import.meta.url), "utf8");
const uiSource = readFileSync(new URL("./ui.tsx", import.meta.url), "utf8");

test("renders a floating elevated progress chip without an inline expanding panel", () => {
  const html = renderToStaticMarkup(
    <TodoPanel
      snapshot={{
        version: 1,
        chatId: "chat-1",
        availability: "ready",
        tasks: [
          { id: 1, subject: "Research", status: "completed" },
          { id: 2, subject: "Implement", status: "in_progress", activeForm: "Writing code" },
          { id: 3, subject: "Verify", status: "pending", blockedBy: [2] },
        ],
      }}
    />,
  );
  assert.match(html, /Step 2 \/ 3/u);
  assert.match(html, /Writing code/u);
  assert.match(html, /bottom-full/u);
  assert.match(html, /shadow-popover/u);
  assert.match(html, /Focus or hover for full details/u);
  assert.doesNotMatch(html, /<details/u);
  assert.match(html, /role="status"/u);
  assert.match(html, /aria-live="polite"/u);
  assert.match(html, /aria-atomic="true"/u);
  assert.match(html, /Task progress: 1 of 3 completed\. In progress: Writing code\./u);
  assert.match(source, /<HoverCard openDelay=\{160\} closeDelay=\{120\}>/u);
  assert.match(source, /<HoverCardContent[\s\S]*side="top"/u);
  assert.doesNotMatch(source, /hover:-translate|focus-visible:-translate/u);
  assert.match(source, /Blocked by\{" "\}/u);
  assert.match(source, /max-h-\[min\(26rem,55vh\)\]/u);
  assert.match(source, /taskStatusText\(task, dependencyIds\)/u);
  assert.doesNotMatch(source, />Task progress<|complete<\/span>/u);
  assert.match(chatPaneSource, /scrollToBottomButtonOffset=\{[\s\S]*\? 44[\s\S]*: 0/u);
  assert.match(uiSource, /footerHeight \+ 12 \+ Math\.max\(0, scrollToBottomButtonOffset\)/u);
});

test("bounds the polite progress announcement even for maximum-length task copy", () => {
  const html = renderToStaticMarkup(
    <TodoPanel
      snapshot={{
        version: 1,
        chatId: "chat-1",
        availability: "ready",
        tasks: [
          {
            id: 1,
            subject: "S".repeat(480),
            status: "in_progress",
            activeForm: "A".repeat(320),
          },
        ],
      }}
    />,
  );
  const announcement = html.match(/role="status"[^>]*>([^<]+)</u)?.[1] ?? "";
  assert.equal(Array.from(announcement).length, 360);
  assert.match(announcement, /…$/u);
});

test("hides empty and fully completed plans while preserving completion announcement", () => {
  assert.equal(
    renderToStaticMarkup(
      <TodoPanel snapshot={{ version: 1, chatId: "chat-1", availability: "ready", tasks: [] }} />,
    ),
    "",
  );
  const completed = renderToStaticMarkup(
    <TodoPanel
      snapshot={{
        version: 1,
        chatId: "chat-1",
        availability: "ready",
        tasks: [{ id: 1, subject: "Done", status: "completed" }],
      }}
    />,
  );
  assert.doesNotMatch(completed, /<button/u);
  assert.match(completed, /All tasks complete/u);
});

test("fail-closed state uses a floating warning chip instead of reserving chat height", () => {
  const unavailable = renderToStaticMarkup(
    <TodoPanel
      snapshot={{ version: 1, chatId: "chat-1", availability: "unavailable", tasks: [] }}
    />,
  );
  assert.match(unavailable, /Tasks unavailable/u);
  assert.match(source, /could not verify this chat’s private task state/u);
  assert.match(source, /absolute inset-x-0 bottom-full/u);
  assert.match(unavailable, /role="status"/u);
  assert.match(unavailable, /aria-live="polite"/u);
});
