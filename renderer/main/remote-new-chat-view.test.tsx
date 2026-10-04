import assert from "node:assert/strict";
import test from "node:test";
import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DOMParser } from "@xmldom/xmldom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RemoteBotsSection } from "../components/remote-bots-section";
import { SCRATCH_PROJECT } from "../components/remote-new-chat-pickers";
import { CommandSystemProvider } from "../lib/command-system";
import type { HostChatCapability } from "../lib/hosts/host-chat-adapter";
import type { HostModelCatalog } from "../lib/hosts/host-resources";
import type { NewChatMachine } from "../lib/hosts/new-chat-targets";
import type { RemoteNewChatSnapshot } from "../lib/hosts/remote-new-chat";
import { RemoteFolderList, RemoteNewChatPane, type RemoteNewChatPaneProps } from "./remote-new-chat-view";

const noop = () => undefined;
const asyncNoop = async () => undefined;

const studio: NewChatMachine = { id: "host-b", label: "Studio", availability: "online" };
const laptop: NewChatMachine = { id: "host-c", label: "Laptop", availability: "offline", disabledReason: "Laptop is offline." };
const CHAT: HostChatCapability[] = ["send", "attach", "createChat"];

const catalog: HostModelCatalog = {
  providers: [{ id: "prov", label: "Provider", models: [{ id: "fast", label: "Fast model", supportsImages: false }] }],
  defaults: { providerId: "prov", modelId: "fast" },
};

function ready(patch: Partial<RemoteNewChatSnapshot> = {}): RemoteNewChatSnapshot {
  return { status: { availability: "online", generation: 1 }, starting: false, unresolved: null, ...patch };
}

function dom(markup: string) {
  const document = new DOMParser().parseFromString(`<!doctype html><html><body>${markup}</body></html>`, "text/html");
  const all = Array.from(document.getElementsByTagName("*"));
  const buttons = all.filter((node) => node.tagName.toLowerCase() === "button");
  return {
    text: (document.documentElement?.textContent ?? "").replace(/\s+/g, " "),
    all,
    buttons,
    button: (label: RegExp) =>
      buttons.find((node) => label.test(node.textContent ?? "") || label.test(node.getAttribute("aria-label") ?? "")),
    attr: (name: string) => all.find((node) => node.hasAttribute(name))?.getAttribute(name) ?? null,
  };
}

function renderPane(patch: Partial<RemoteNewChatPaneProps> = {}) {
  const props: RemoteNewChatPaneProps = {
    host: studio,
    machines: [studio, laptop],
    capabilities: new Set(CHAT),
    snapshot: ready(),
    projects: [{ id: "w-1", name: "Site", detail: "site-repo" }],
    project: "w-1",
    models: catalog,
    modelsLoading: false,
    model: { providerId: "prov", modelId: "fast" },
    onSelectMachine: noop,
    onSelectProject: noop,
    onBrowse: noop,
    onSelectModel: noop,
    onSend: asyncNoop,
    onRetry: noop,
    onDismiss: noop,
    onOpenChat: noop,
    onReconnect: asyncNoop,
    onManage: noop,
    ...patch,
  };
  return dom(
    renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <CommandSystemProvider>
          <RemoteNewChatPane {...props} />
        </CommandSystemProvider>
      </QueryClientProvider>,
    ),
  );
}

test("a new chat on a paired Mac names that Mac and its project, model and machine, with no local workspace controls", () => {
  const view = renderPane();
  assert.match(view.text, /New chat/u);
  assert.match(view.text, /Runs on Studio/u);
  assert.match(view.text, /What would you like to work on with Studio\?/u);
  assert.equal(view.attr("data-new-chat-machine"), "host-b");
  assert.equal(view.attr("data-remote-project"), "w-1");
  assert.ok(view.button(/^Project on Studio: Site$/u));
  assert.ok(view.button(/^Model on Studio: Fast model$/u));
  assert.ok(view.button(/^Attach files or images$/u), "the host stages uploads, so files can be attached");
  assert.equal(
    view.buttons.some((node) => (node.getAttribute("aria-label") ?? "").startsWith("Workspace access")),
    false,
    "this Mac's workspace access control never appears for a remote chat",
  );
  assert.equal(view.attr("data-remote-new-chat-unresolved"), null);
  assert.doesNotMatch(view.text, /first\.|Connecting to/u, "nothing holds the first message back");
});

test("sending waits for a project, a reachable host and a connected control", () => {
  const needsProject = renderPane({ project: "" });
  assert.match(needsProject.text, /Choose a project on Studio first\./u);

  const noProjects = renderPane({ project: "", projects: [], capabilities: new Set<HostChatCapability>(["send", "createChat"]) });
  assert.match(noProjects.text, /Studio has no projects this Mac can use yet\./u);

  const foreign = renderPane({ project: "w-from-another-mac" });
  assert.match(foreign.text, /Choose a project on Studio first\./u, "a project this host does not list cannot be sent to");

  const connecting = renderPane({ snapshot: null });
  assert.match(connecting.text, /Connecting to Studio…/u);

  const offline = renderPane({ host: laptop });
  assert.match(offline.text, /Laptop is offline\./u);
  assert.ok(offline.button(/Reconnect|Manage/u), "an unavailable host offers its status actions");

  const scratch = renderPane({ project: SCRATCH_PROJECT });
  assert.equal(scratch.attr("data-remote-project"), SCRATCH_PROJECT);
  assert.ok(scratch.button(/^Project on Studio: No project$/u));
});

test("a first message the host may not have received offers retry, dismiss and opening the chat", () => {
  const view = renderPane({
    snapshot: ready({
      unresolved: { chatId: "chat-9", text: "Draft the launch notes", message: "Studio may not have received this.", retrying: false },
    }),
  });
  assert.equal(view.attr("data-remote-new-chat-unresolved"), "true");
  assert.match(view.text, /Draft the launch notes/u);
  assert.match(view.text, /Retry or dismiss the message above before sending another\./u);
  for (const label of [/^Retry$/u, /^Dismiss$/u, /^Open chat$/u]) {
    const action = view.button(label);
    assert.ok(action, `missing ${label}`);
    assert.equal(action.hasAttribute("disabled"), false);
  }

  const retrying = renderPane({
    snapshot: ready({ unresolved: { chatId: "chat-9", text: "Draft", message: "Checking.", retrying: true } }),
  });
  assert.equal(retrying.button(/^Retry$/u)?.hasAttribute("disabled"), true);
  assert.equal(retrying.button(/^Dismiss$/u)?.hasAttribute("disabled"), true);
});

test("the folder browser lists a host's shared roots, then a folder's subfolders with breadcrumbs and paging", () => {
  const roots = dom(
    renderToStaticMarkup(
      <RemoteFolderList
        hostLabel="Studio"
        roots={[{ id: "r1", label: "Projects", location: "loc-r1" }]}
        rootsError={null}
        place={null}
        pages={[]}
        loading={false}
        error={null}
        hasMore={false}
        busy={false}
        onOpen={noop}
        onLoadMore={noop}
      />,
    ),
  );
  assert.ok(roots.all.some((node) => node.getAttribute("aria-label") === "Shared folders on Studio"));
  assert.ok(roots.button(/^Projects$/u));
  assert.equal(roots.button(/^Show more$/u), undefined);

  const inside = dom(
    renderToStaticMarkup(
      <RemoteFolderList
        hostLabel="Studio"
        roots={[{ id: "r1", label: "Projects", location: "loc-r1" }]}
        rootsError={null}
        place={{ location: { label: "site", location: "loc-site" }, trail: ["r1", "e-site"] }}
        pages={[
          {
            rootId: "r1",
            label: "site",
            breadcrumbs: [
              { label: "Projects", location: "loc-r1" },
              { label: "site", location: "loc-site" },
            ],
            entries: [
              { id: "e1", name: "docs", location: "loc-docs" },
              { id: "e2", name: "src", location: "loc-src" },
            ],
            nextCursor: "c2",
          },
        ]}
        loading={false}
        error={null}
        hasMore
        busy={false}
        onOpen={noop}
        onLoadMore={noop}
      />,
    ),
  );
  assert.ok(inside.all.some((node) => node.getAttribute("aria-label") === "Folders in site"));
  assert.ok(inside.button(/^docs$/u));
  assert.ok(inside.button(/^src$/u));
  assert.equal(inside.button(/^Projects$/u)?.hasAttribute("disabled"), false, "an ancestor can be reopened");
  assert.equal(inside.buttons.filter((node) => node.textContent === "site")[0]?.hasAttribute("disabled"), true);
  assert.ok(inside.button(/^Show more$/u));

  const failed = dom(
    renderToStaticMarkup(
      <RemoteFolderList
        hostLabel="Studio"
        roots={undefined}
        rootsError="Studio refused the folder list."
        place={null}
        pages={[]}
        loading={false}
        error={null}
        hasMore={false}
        busy={false}
        onOpen={noop}
        onLoadMore={noop}
      />,
    ),
  );
  assert.match(failed.text, /Studio refused the folder list\./u);

  const empty = dom(
    renderToStaticMarkup(
      <RemoteFolderList
        hostLabel="Studio"
        roots={[]}
        rootsError={null}
        place={null}
        pages={[]}
        loading={false}
        error={null}
        hasMore={false}
        busy={false}
        onOpen={noop}
        onLoadMore={noop}
      />,
    ),
  );
  assert.match(empty.text, /Studio hasn't shared any folders with this Mac\./u);
});

test("Bots on paired Macs are grouped by Mac, and a Mac that cannot open them says why", () => {
  const render = (props: Partial<React.ComponentProps<typeof RemoteBotsSection>>) =>
    dom(
      renderToStaticMarkup(
        <RemoteBotsSection
          groups={[
            { host: studio, bots: [{ id: "bot-1", name: "Reviewer", purpose: "Reviews pull requests" }, { id: "bot-2", name: "Scribe" }] },
            { host: laptop, bots: [{ id: "bot-3", name: "Planner" }] },
          ]}
          opening={null}
          onOpen={noop}
          {...props}
        />,
      ),
    );
  const view = render({});
  assert.match(view.text, /On Studio/u);
  assert.match(view.text, /Reviews pull requests/u);
  assert.match(view.text, /A Bot on Studio\./u);
  assert.match(view.text, /On Laptop/u);
  assert.match(view.text, /Laptop is offline\./u);
  assert.equal(view.button(/^Reviewer, on Studio$/u)?.hasAttribute("disabled"), false);
  assert.equal(view.button(/^Planner, on Laptop$/u)?.hasAttribute("disabled"), true);

  const opening = render({ opening: "host-b/bot-1" });
  assert.equal(opening.button(/^Reviewer, on Studio$/u)?.getAttribute("aria-busy"), "true");
  assert.equal(opening.button(/^Scribe, on Studio$/u)?.hasAttribute("disabled"), true, "one Bot chat opens at a time");

  assert.equal(renderToStaticMarkup(<RemoteBotsSection groups={[]} opening={null} onOpen={noop} />), "");
});
