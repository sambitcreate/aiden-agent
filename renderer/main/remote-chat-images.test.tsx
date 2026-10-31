import { installBotTestIpc } from "./bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { mountWithBotRouter } from "./bots/test-providers";
import { ChatIntentLedger } from "../lib/hosts/chat-intent-ledger";
import { ChatSessionControl } from "../lib/hosts/chat-session-control";
import type { HostChatAdapter, HostChatCapability, HostChatResult, HostChatStatus } from "../lib/hosts/host-chat-adapter";
import type { RemoteChatSnapshot } from "../lib/hosts/remote-chat-session";
import { initialRemoteRunView } from "../lib/hosts/remote-stream-translator";
import type { SidebarHost } from "../lib/sidebar-remote-groups";
import type { ChatMessage } from "../lib/types";
import type { PeerAttachmentContent } from "../shared/peer-operation";
import { RemoteChatPane } from "./remote-chat-view";

afterEach(() => cleanup());

const noop = () => undefined;
const HOST: SidebarHost = { id: "host-b", label: "Studio", availability: "online" };
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** A paired host whose transcripts list images by name and size, with the bytes read on demand. */
class ImageHost implements HostChatAdapter {
  readonly hostId = "host-b";
  readonly reads: string[] = [];
  active = 0;
  mostAtOnce = 0;
  private readonly current: HostChatStatus = { availability: "online", generation: 1 };
  constructor(private readonly bytes: (attachmentId: string) => HostChatResult<PeerAttachmentContent>) {}
  capabilities(): ReadonlySet<HostChatCapability> {
    return new Set<HostChatCapability>(["messagesWindow", "observe", "send"]);
  }
  ready() {
    return Promise.resolve();
  }
  status() {
    return this.current;
  }
  onStatus() {
    return noop;
  }
  onChatChanged() {
    return noop;
  }
  getMessagesWindow(): never {
    throw new Error("unused");
  }
  async attachmentContent(_chatId: string, attachmentId: string) {
    this.reads.push(attachmentId);
    this.active += 1;
    this.mostAtOnce = Math.max(this.mostAtOnce, this.active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.active -= 1;
    return this.bytes(attachmentId);
  }
  observe() {
    return noop;
  }
  async markRead() {
    return { ok: true as const, value: undefined };
  }
  async send(): Promise<never> {
    throw new Error("unused");
  }
  async cancel() {
    return false;
  }
  async respondApproval(): Promise<never> {
    throw new Error("unused");
  }
  async answerQuestion(): Promise<never> {
    throw new Error("unused");
  }
  async submitInput(): Promise<never> {
    throw new Error("unused");
  }
  async rename() {}
  async remove() {}
  dispose() {}
}

const TWO_IMAGES: ChatMessage[] = [
  {
    id: "m1",
    role: "user",
    content: "Here is the mockup",
    createdAt: 1,
    attachments: [{ id: "att-1", name: "mockup.png", mimeType: "image/png", kind: "image", size: PIXEL.byteLength }],
  },
  {
    id: "m2",
    role: "assistant",
    content: "I drew a cleaner version",
    createdAt: 2,
    attachments: [{ id: "att-2", name: "cleaner.png", mimeType: "image/png", kind: "image", size: PIXEL.byteLength }],
  },
];

async function mount(
  bytes: (attachmentId: string) => HostChatResult<PeerAttachmentContent>,
  messages: ChatMessage[] = TWO_IMAGES,
) {
  installBotTestIpc({});
  const adapter = new ImageHost(bytes);
  const control = new ChatSessionControl(adapter, { hostId: "host-b", chatId: "chat-1" }, new ChatIntentLedger());
  control.attach();
  const snapshot: RemoteChatSnapshot = {
    hostId: "host-b",
    chatId: "chat-1",
    status: { availability: "online", generation: 1 },
    transcript: { chatId: "chat-1", revision: "r1", messages, hasOlder: false },
    loaded: true,
    loading: false,
    loadingOlder: false,
    stale: false,
    error: null,
    run: initialRemoteRunView(null, "chat-1"),
  };
  await mountWithBotRouter(
    <RemoteChatPane
      title="Mockups"
      host={HOST}
      snapshot={snapshot}
      chat={{ control, snapshot: control.getSnapshot() }}
      onLoadOlder={noop}
      onReconnect={async () => undefined}
      onManage={noop}
      onRemoved={noop}
    />,
  );
  return adapter;
}

test("images in another Mac's chat draw here once their bytes are read from that Mac", async () => {
  const host = await mount(() => ({ ok: true, value: { mimeType: "image/png", bytes: new Uint8Array(PIXEL) } }));
  const source = `data:image/png;base64,${PIXEL.toString("base64")}`;
  const sent = (await screen.findByRole("img", { name: "mockup.png" })) as HTMLImageElement;
  const reply = (await screen.findByRole("img", { name: "cleaner.png" })) as HTMLImageElement;
  assert.equal(sent.getAttribute("src"), source);
  assert.equal(reply.getAttribute("src"), source);
  assert.deepEqual([...host.reads].sort(), ["att-1", "att-2"]);
  // Expand opens the image here; Save and Copy read chats this Mac stores, so they are not offered.
  assert.ok(screen.getByRole("button", { name: "Expand" }));
  assert.ok(!screen.queryByRole("button", { name: "Save" }), "no Save on another Mac's image");
  assert.ok(!screen.queryByRole("button", { name: "Copy" }), "no Copy on another Mac's image");
});

test("an image the other Mac cannot hand over, or hands over changed, stays a named file", async () => {
  const host = await mount((attachmentId) =>
    attachmentId === "att-1"
      ? { ok: false, error: { code: "not_found", message: "This attachment is unavailable." } }
      : { ok: true, value: { mimeType: "image/png", bytes: new Uint8Array(PIXEL.subarray(1)) } },
  );
  await waitFor(() => assert.ok(host.reads.includes("att-1") && host.reads.includes("att-2")));
  assert.ok(await screen.findByText("mockup.png"));
  assert.ok(screen.getByText("cleaner.png"));
  assert.ok(!screen.queryByRole("img", { name: "mockup.png" }), "no picture for an unreadable image");
  assert.ok(!screen.queryByRole("img", { name: "cleaner.png" }), "no picture for bytes that differ from the listing");
});

test("a chat full of pictures reads them from the other Mac a few at a time, so the host never refuses one", async () => {
  const shots: ChatMessage[] = Array.from({ length: 8 }, (_, index) => ({
    id: `s${index}`,
    role: "user",
    content: `Screen ${index}`,
    createdAt: 10 + index,
    attachments: [
      { id: `shot-${index}`, name: `screen-${index}.png`, mimeType: "image/png", kind: "image", size: PIXEL.byteLength },
    ],
  }));
  const host = await mount(() => ({ ok: true, value: { mimeType: "image/png", bytes: new Uint8Array(PIXEL) } }), shots);
  for (let index = 0; index < shots.length; index += 1) assert.ok(await screen.findByRole("img", { name: `screen-${index}.png` }));
  assert.equal(host.reads.length, 8, "each picture is read once");
  // The host takes 8 requests from a Mac at once; pictures leave room for sends and approvals.
  assert.ok(host.mostAtOnce <= 3, `read ${host.mostAtOnce} at once`);
});
