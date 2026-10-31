import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatRow, type ChatRowMenu, type ChatRowProps } from "./chat-row.js";
import { RowGroup } from "./row-group.js";
import { SectionHeader } from "./section-header.js";
import { remoteChatRowActions, type RemoteSidebarChat } from "../../lib/sidebar-remote-groups.js";
import type { HostChatCapability } from "../../lib/hosts/host-chat-adapter.js";

function labels(markup: string): string[] {
  return [...markup.matchAll(/aria-label="([^"]+)"/gu)].map((match) => match[1]!);
}

/** The `aria-busy` value on the row's own button. */
function rowBusy(markup: string): string | undefined {
  return /<button[^>]*data-roving-item[^>]*aria-busy="([^"]+)"/u.exec(markup)?.[1]
    ?? /<button[^>]*aria-busy="([^"]+)"[^>]*data-roving-item/u.exec(markup)?.[1];
}

function row(props: Partial<ChatRowProps> = {}): string {
  return renderToStaticMarkup(
    <ChatRow
      title="Fix the build"
      status={{ state: "idle", unread: false }}
      onOpen={() => {}}
      {...props}
    />,
  );
}

const menu: ChatRowMenu = (Item) => <Item>Open</Item>;

test("each row state shows its one status pill next to the title", () => {
  const expected = {
    needs_approval: ["Needs approval"],
    needs_input: ["Needs input"],
    working: ["Working"],
    idle: [],
  } as const;
  for (const [state, pills] of Object.entries(expected)) {
    const markup = row({ status: { state: state as keyof typeof expected, unread: false } });
    assert.deepEqual(labels(markup), pills, state);
    assert.match(markup, />Fix the build</u, state);
  }
  assert.deepEqual(labels(row({ status: { state: "idle", unread: true, failed: true } })), ["Failed"]);
});

test("the open chat never shows unread, other rows do", () => {
  const unread = { state: "idle", unread: true } as const;
  assert.deepEqual(labels(row({ status: unread })), ["Unread"]);
  const open = row({ status: unread, selected: true });
  assert.deepEqual(labels(open), []);
  assert.doesNotMatch(open, /data-chat-unread/u);
});

test("aria-busy is true only while Working or while the caller reports extra work", () => {
  assert.equal(rowBusy(row({ status: { state: "working", unread: false } })), "true");
  for (const state of ["needs_approval", "needs_input", "idle"] as const) {
    assert.equal(rowBusy(row({ status: { state, unread: true } })), "false", state);
  }
  assert.equal(rowBusy(row({ busy: true })), "true");
});

test("a remote row carries its host marker and a ••• menu named for the chat", () => {
  const live = row({ remote: { hostLabel: "Studio Mac", stale: false }, menu });
  assert.deepEqual(labels(live), ["On Studio Mac", "More for Fix the build"]);
  assert.match(live, /data-remote-chat="live"/u);
  assert.match(live, /data-remote-host-marker="true"/u);
  assert.match(live, /<button[^>]*aria-label="More for Fix the build"[^>]*aria-haspopup="menu"|<button[^>]*aria-haspopup="menu"[^>]*aria-label="More for Fix the build"/u);

  const stale = row({ remote: { hostLabel: "Studio Mac", stale: true } });
  assert.deepEqual(labels(stale), ["On Studio Mac, offline"]);
  assert.match(stale, /data-remote-chat="stale"/u);
  assert.doesNotMatch(stale, /aria-haspopup/u, "a row without actions has no ••• button");
});

test("holding the shortcut modifier swaps the ••• button for the shortcut hint", () => {
  const hidden = row({ menu, shortcutHint: "⌘1" });
  assert.doesNotMatch(hidden, /data-chat-shortcut-hint/u);
  assert.match(hidden, /aria-haspopup="menu"/u);

  const revealed = row({ menu, shortcutHint: "⌘1", shortcutsRevealed: true });
  assert.match(revealed, /<kbd[^>]*data-chat-shortcut-hint="true"[^>]*>⌘1<\/kbd>/u);
  assert.doesNotMatch(revealed, /aria-haspopup="menu"/u);
});

function remoteChat(overrides: Partial<RemoteSidebarChat> = {}): RemoteSidebarChat {
  return {
    key: "remote:host-1:chat-1",
    projectKey: "remote:host-1:ws-1",
    title: "Fix the build",
    attention: "none",
    remote: true,
    hostId: "host-1",
    hostLabel: "Studio Mac",
    chatId: "chat-1",
    workspaceId: "ws-1",
    rowState: "idle",
    unread: true,
    lastRunFailed: false,
    stale: false,
    revision: "rev-7",
    ...overrides,
  };
}

const ids = (chat: RemoteSidebarChat, granted: HostChatCapability[]) =>
  remoteChatRowActions(chat, new Set(granted)).map((action) => action.id);

test("remote rows offer only the actions the host grants", () => {
  assert.deepEqual(ids(remoteChat(), []), ["open"]);
  assert.deepEqual(ids(remoteChat(), ["markRead"]), ["open", "markRead"]);
  assert.deepEqual(ids(remoteChat(), ["rename"]), ["open", "rename"]);
  // Granted control the sidebar has no menu item for (delete, send) never adds one.
  assert.deepEqual(ids(remoteChat(), ["markRead", "rename", "remove", "send"]), [
    "open",
    "markRead",
    "rename",
  ]);
});

test("remote mark read needs an unread row and rename needs the host's revision", () => {
  assert.deepEqual(ids(remoteChat({ unread: false }), ["markRead", "rename"]), ["open", "rename"]);
  assert.deepEqual(ids(remoteChat({ revision: undefined }), ["markRead", "rename"]), ["open", "markRead"]);
});

test("an offline host's rows keep Open but disable the actions that need the host", () => {
  const actions = remoteChatRowActions(remoteChat({ stale: true }), new Set(["markRead", "rename"]));
  assert.deepEqual(actions, [
    { id: "open", disabled: false },
    { id: "markRead", disabled: true },
    { id: "rename", disabled: true },
  ]);
});

test("a row group shows its rows only while expanded and names the toggle for the next step", () => {
  const render = (expanded: boolean) =>
    renderToStaticMarkup(
      <RowGroup expanded={expanded} icon={null} title="aiden-agent" accessibleName="aiden-agent workspace" onToggle={() => {}}>
        <span data-child="row">child</span>
      </RowGroup>,
    );
  const open = render(true);
  assert.match(open, /aria-label="Collapse aiden-agent workspace"/u);
  assert.match(open, /aria-expanded="true"/u);
  assert.match(open, /data-child="row"/u);

  const closed = render(false);
  assert.match(closed, /aria-label="Expand aiden-agent workspace"/u);
  assert.match(closed, /aria-expanded="false"/u);
  assert.doesNotMatch(closed, /data-child="row"/u);
});

test("a section header shows its count and only becomes a button when collapsible", () => {
  const plain = renderToStaticMarkup(<SectionHeader label="Today" count={3} />);
  assert.match(plain, /Today/u);
  assert.match(plain, /<span[^>]*data-section-count="true"[^>]*>3<\/span>/u);
  assert.doesNotMatch(plain, /<button/u);

  const collapsible = renderToStaticMarkup(
    <SectionHeader label="Done" collapse={{ expanded: false, onToggle: () => {} }} />,
  );
  assert.match(collapsible, /<button[^>]*aria-expanded="false"[^>]*>.*Done.*<\/button>/u);
});
