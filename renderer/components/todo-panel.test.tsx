import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TodoPanel } from "./todo-panel.js";

test("renders bounded progress, current work, dependencies, and completed state", () => {
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
  assert.match(html, /Tasks/u);
  assert.match(html, /1\/3/u);
  assert.match(html, /Writing code/u);
  assert.match(html, /Blocked by #2 Implement/u);
  assert.match(html, /line-through/u);
  assert.match(html, /max-h-48/u);
  assert.match(html, /role="status"/u);
  assert.match(html, /aria-live="polite"/u);
  assert.match(html, /aria-atomic="true"/u);
  assert.match(html, /Task progress: 1 of 3 completed\. In progress: Writing code\./u);
  assert.match(html, /Completed\./u);
  assert.match(html, /In progress\./u);
  assert.match(html, /Pending, blocked by task 2\./u);
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

test("hides empty ready state and explains fail-closed state inline", () => {
  assert.equal(
    renderToStaticMarkup(
      <TodoPanel snapshot={{ version: 1, chatId: "chat-1", availability: "ready", tasks: [] }} />,
    ),
    "",
  );
  assert.match(
    renderToStaticMarkup(
      <TodoPanel
        snapshot={{ version: 1, chatId: "chat-1", availability: "unavailable", tasks: [] }}
      />,
    ),
    /could not be verified/u,
  );
});
