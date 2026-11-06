import "../main/bots/test-dom";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { installBotTestIpc } from "../main/bots/test-dom";
import { fetchTranscriptImage } from "../../main/services/transcript-image-fetch";
import { Markdown, MarkdownInline } from "./markdown";
import { StreamingMarkdownReveal } from "./streaming-markdown-reveal";
import { MessageAttachments } from "./message-attachments";
import { MessageList } from "./message-list";

afterEach(cleanup);
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2aQAAAABJRU5ErkJggg==";

test("rendered streaming and restored Markdown fetch nothing until click, scope approval to a message and exact URL", async () => {
  const paths: string[] = [];
  const server = http.createServer((request, response) => {
    paths.push(request.url!);
    response.writeHead(200, { "content-type": "image/png" }).end(Buffer.from(PNG, "base64"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const calls = installBotTestIpc({ "chat:loadTranscriptImage": (url) => fetchTranscriptImage(url, { allowAddress: (address) => address === "127.0.0.1" }) });
    document.documentElement.dataset.reduceMotion = "true";
    const content = `![chart](${origin}/first)\n\n![other](https://example.test/other)`;
    const view = render(<StreamingMarkdownReveal content={content} imageScope="message-1" />);
    assert.equal(view.container.querySelector("img,link[rel=preload]"), null);
    assert.deepEqual(paths, []); assert.equal(calls.length, 0);
    view.rerender(<StreamingMarkdownReveal content={content + "\n\nMore text."} imageScope="message-1" complete />);
    assert.equal(view.container.querySelector("img"), null);
    fireEvent.click(view.getAllByRole("button", { name: "Load image" })[0]!);
    await waitFor(() => assert.equal(view.container.querySelector("img")?.getAttribute("src"), `data:image/png;base64,${PNG}`));
    assert.deepEqual(paths, ["/first"]);
    assert.equal(view.container.querySelector("img")?.alt, "chart");
    view.rerender(<StreamingMarkdownReveal content={content + "\n\nSettled text."} imageScope="message-1" complete />);
    assert.equal(view.container.querySelectorAll("img").length, 1);
    view.rerender(<StreamingMarkdownReveal content={`![chart](${origin}/changed)`} imageScope="message-1" complete />);
    assert.equal(view.container.querySelector("img"), null);
    assert.deepEqual(paths, ["/first"]);
    fireEvent.click(view.getByRole("button", { name: "Load image" }));
    await waitFor(() => assert.equal(paths.length, 2));
    view.rerender(<StreamingMarkdownReveal content={`![chart](${origin}/changed)`} imageScope="message-2" complete />);
    assert.equal(view.container.querySelector("img"), null);
    view.unmount();
    const restored = render(<Markdown content={content} imageScope="message-1" />);
    assert.equal(restored.container.querySelector("img"), null);
    assert.deepEqual(paths, ["/first", "/changed"]);
  } finally {
    delete document.documentElement.dataset.reduceMotion;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("restricted, relative and sanitized embedded sources never gain a load action; generated attachment gallery stays intact", () => {
  const calls = installBotTestIpc();
  const view = render(<><Markdown content="![private](https://example.test/pixel)" restricted={{ inert: false, openLink: () => {} }} />
    <Markdown content="![relative](/private.png) ![local](file:///private.png) ![embedded](data:image/png;base64,AA==)" />
    <MessageAttachments role="assistant" attachments={[{ id: "generated", kind: "image", mimeType: "image/png", data: PNG, size: 70, name: "Generated chart" }]} /></>);
  assert.equal(view.queryByRole("button", { name: "Load image" }), null);
  assert.equal(calls.length, 0);
  assert.equal(view.container.querySelectorAll("img").length, 1);
  fireEvent.click(view.getByRole("button", { name: "Open Generated chart preview" }));
  assert.equal(document.querySelector("[data-attachment-full-view]")?.getAttribute("src"), `data:image/png;base64,${PNG}`);
});

test("inline images and protocol-relative URLs use the same consent action, and failures remain accessible", async () => {
  const calls = installBotTestIpc({ "chat:loadTranscriptImage": () => { throw new Error("Images on a private network cannot be loaded."); } });
  const view = render(<MarkdownInline content="![diagram](//example.test/diagram.png)" />);
  assert.equal(calls.length, 0);
  await act(async () => fireEvent.click(view.getByRole("button", { name: "Load image" })));
  assert.equal(calls[0]?.args[0], "//example.test/diagram.png");
  assert.match(view.getByRole("status").textContent!, /private network/u);
  assert.equal(view.container.querySelector("img"), null);
});


test("consent survives the real live-to-history handoff and never crosses to another chat", async () => {
  const calls = installBotTestIpc({ "chat:loadTranscriptImage": () => ({ mimeType: "image/png", data: PNG, width: 1, height: 1 }) });
  document.documentElement.dataset.reduceMotion = "true";
  const content = "![chart](https://images.example/chart.png)";
  const prompt = { id: "prompt", role: "user" as const, content: "Show chart", createdAt: 1 };
  const reply = { id: "answer", role: "assistant" as const, content, createdAt: 2 };
  const common = { chatId: "chat-1", streamingReasoning: null, timeline: null, liveSubagents: [], subagentsEnabled: false,
    onOpenSubagent: () => {}, agentActivity: null, error: null };
  try {
    const view = render(<MessageList {...common} messages={[prompt]} streamingText={content} />);
    await act(async () => fireEvent.click(view.getByRole("button", { name: "Load image" })));
    const image = view.container.querySelector("img"); assert.ok(image);
    view.rerender(<MessageList {...common} messages={[prompt, reply]} streamingText={content} streamComplete persistedHandoffMessageId="answer" />);
    assert.equal(view.container.querySelector("img"), image);
    view.rerender(<MessageList {...common} messages={[prompt, reply]} streamingText={null} />);
    assert.equal(view.container.querySelector("img"), image);
    assert.equal(calls.length, 1);
    view.rerender(<MessageList {...common} chatId="chat-2" messages={[prompt, reply]} streamingText={null} />);
    assert.equal(view.container.querySelector("img"), null);
    assert.equal(calls.length, 1);
  } finally { delete document.documentElement.dataset.reduceMotion; }
});

test("Load image inside a Markdown link does not also navigate the enclosing link", async () => {
  let navigations = 0;
  installBotTestIpc({ "chat:loadTranscriptImage": () => ({ mimeType: "image/png", data: PNG, width: 1, height: 1 }) });
  const view = render(<div onClick={() => { navigations++; }}><Markdown content="[![chart](https://images.example/chart.png)](https://outside.example/page)" /></div>);
  let defaultAllowed = true;
  await act(async () => { defaultAllowed = fireEvent.click(view.getByRole("button", { name: "Load image" })); });
  assert.equal(defaultAllowed, false);
  assert.equal(navigations, 0);
  assert.equal(view.container.querySelector("img")?.alt, "chart");
});
