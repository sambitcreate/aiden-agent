// Installs the DOM before the router and dialog imports.
import { installBotTestIpc } from "./bots/test-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CommandSystemProvider } from "../lib/command-system";
import { TooltipProvider } from "../components/ui";
import { hostQueryKeys } from "../lib/hosts/host-query-keys";
import type { PeerHostView, PeerHostStatus } from "../shared/peer-host";
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PeerProjectCloneDialog, PeerProjectEnvironmentFiles } from "./peer-project-clone-dialog.js";
const source = { name: "Widget", repositoryName: "widget", url: "https://example.invalid/widget.git", files: [{ name: ".env", bytes: 42 }, { name: ".dev.vars", bytes: 5 }] };
test("environment-file consent starts unchecked, names the secret risk, and disables edits during a clone", () => {
  const initial = renderToStaticMarkup(<PeerProjectEnvironmentFiles source={source} selected={new Set()} disabled={false} onToggle={() => {}} />);
  assert.equal((initial.match(/type="checkbox"/gu) ?? []).length, 2);
  assert.equal((initial.match(/checked=""/gu) ?? []).length, 0);
  assert.match(initial, /may contain secrets/);
  assert.match(initial, /Nothing is selected by default/);
  const selected = renderToStaticMarkup(<PeerProjectEnvironmentFiles source={source} selected={new Set([".dev.vars"])} disabled onToggle={() => {}} />);
  assert.equal((selected.match(/checked=""/gu) ?? []).length, 1);
  assert.match(selected, /<fieldset[^>]*disabled=""/u);
});


test("the real clone dialog waits for folder approval and sends only explicit environment choices", async () => {
  for (const stopped of [false, true]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const host: PeerHostView = { id: "studio", name: "Studio", enabled: true, state: "connected", features: ["workspace-clone-v1"], capabilities: ["workspace:manage", "workspace:browse"] };
  const status: PeerHostStatus = { hostId: host.id, generation: 1, state: { kind: "connected", since: 1 }, feed: "live", stale: false };
  client.setQueryData(hostQueryKeys.list(), [host]);
  client.setQueryData(hostQueryKeys.statuses(), [status]);
  const transfer: unknown[] = [];
  let finish!: (value: unknown) => void;
  let cancel = 0;
  const calls = installBotTestIpc({
    "settings:get": () => null, "shortcut:get": () => null, "app:renderer-ready": () => null,
    "remote:peerHostStatuses": () => [status],
    "workspaces:peerClonePreview": () => source,
    "workspaces:peerClone": (input: unknown) => { transfer.push(input); return new Promise(resolve => { finish = resolve; }); },
    "workspaces:peerCloneCancel": () => { cancel++; return true; },
    "remote:peerCall": (_host: unknown, input: unknown) => {
      const operation = input as { operation: string };
      if (operation.operation === "roots") return { ok: true, value: { roots: [{ id: "root", label: "Projects", location: "loc_root" }] } };
      if (operation.operation === "children") return { ok: true, value: { rootId: "root", label: "Projects", breadcrumbs: [{ label: "Projects", location: "loc_root" }], entries: [] } };
      if (operation.operation === "selectFolder") return { ok: true, value: { selection: `sel_${"a".repeat(43)}`, displayName: "Projects" } };
      throw new Error("Unexpected operation");
    },
  });
  const created: string[] = [];
  render(<QueryClientProvider client={client}><TooltipProvider><CommandSystemProvider><PeerProjectCloneDialog workspaceId="local" onClose={() => {}} onCreated={(hostId, workspace) => { created.push(`${hostId}/${workspace.id}`); }} /></CommandSystemProvider></TooltipProvider></QueryClientProvider>);
  const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); }); };
  try {
    await waitFor(() => { assert.equal(screen.getByRole("button", { name: "Projects" }).textContent?.includes("Projects"), true); });
    const confirm = screen.getByRole("button", { name: "Clone project" }) as HTMLButtonElement;
    assert.equal(confirm.disabled, true);
    assert.equal((screen.getByRole("checkbox", { name: /\.env/ }) as HTMLInputElement).checked, false);
    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    await settle();
    assert.equal(confirm.disabled, false);
    fireEvent.click(screen.getByRole("checkbox", { name: /\.dev.vars/ }));
    fireEvent.click(confirm);
    await settle();
    assert.equal(transfer.length, 1);
    assert.deepEqual((transfer[0] as { files: string[] }).files, [".dev.vars"]);
    assert.equal((screen.getByRole("checkbox", { name: /\.env/ }).closest("fieldset") as HTMLFieldSetElement).disabled, true);
    if (stopped) {
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
      await settle();
      assert.equal(cancel, 1);
    }
    await act(async () => { finish({ ok: true, value: { id: "cloned", name: "Widget" } }); });
    assert.deepEqual(created, stopped ? [] : ["studio/cloned"]);
    if (stopped) assert.match(screen.getByRole("alert").textContent ?? "", /finished before cancellation/);
    assert.equal(calls.filter(call => call.channel === "remote:peerCall" && (call.args[1] as { operation: string }).operation === "selectFolder").length, 1);
  } finally { cleanup(); client.clear(); }
  }
});

test("Stop or unmount during folder selection never starts a later clone", async () => {
  for (const cancel of ["stop", "unmount"] as const) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const host: PeerHostView = { id: "studio", name: "Studio", enabled: true, state: "connected", features: ["workspace-clone-v1"], capabilities: ["workspace:manage", "workspace:browse"] };
    const status: PeerHostStatus = { hostId: host.id, generation: 1, state: { kind: "connected", since: 1 }, feed: "live", stale: false };
    client.setQueryData(hostQueryKeys.list(), [host]); client.setQueryData(hostQueryKeys.statuses(), [status]);
    let selectionStarted = false;
    let releaseSelection!: (value: unknown) => void;
    let cloneCalls = 0;
    let cancelCalls = 0;
    let created = 0;
    const selection = new Promise(resolve => { releaseSelection = resolve; });
    installBotTestIpc({
      "settings:get": () => null, "shortcut:get": () => null, "app:renderer-ready": () => null,
      "remote:peerHostStatuses": () => [status], "workspaces:peerClonePreview": () => source,
      "workspaces:peerCloneCancel": () => { cancelCalls++; return false; },
      "workspaces:peerClone": () => { cloneCalls++; return { ok: true, value: { id: "cloned", name: "Widget" } }; },
      "remote:peerCall": (_host: unknown, raw: unknown) => {
        const operation = (raw as { operation: string }).operation;
        if (operation === "roots") return { ok: true, value: { roots: [{ id: "root", label: "Projects", location: "loc_root" }] } };
        if (operation === "children") return { ok: true, value: { rootId: "root", label: "Projects", breadcrumbs: [{ label: "Projects", location: "loc_root" }], entries: [] } };
        if (operation === "selectFolder") { selectionStarted = true; return selection; }
        throw new Error("Unexpected operation");
      },
    });
    const mounted = render(<QueryClientProvider client={client}><TooltipProvider><CommandSystemProvider><PeerProjectCloneDialog workspaceId="local" onClose={() => {}} onCreated={() => { created++; }} /></CommandSystemProvider></TooltipProvider></QueryClientProvider>);
    try {
      await waitFor(() => { assert.equal(screen.getByRole("button", { name: "Projects" }).textContent?.includes("Projects"), true); });
      fireEvent.click(screen.getByRole("button", { name: "Projects" }));
      await waitFor(() => { assert.equal((screen.getByRole("button", { name: "Clone project" }) as HTMLButtonElement).disabled, false); });
      fireEvent.click(screen.getByRole("button", { name: "Clone project" }));
      await waitFor(() => assert.equal(selectionStarted, true));
      if (cancel === "stop") fireEvent.click(screen.getByRole("button", { name: "Stop" }));
      else mounted.unmount();
      await act(async () => { releaseSelection({ ok: true, value: { selection: `sel_${"a".repeat(43)}`, displayName: "Projects" } }); });
      assert.equal(cancelCalls, 1);
      assert.equal(cloneCalls, 0, cancel);
      assert.equal(created, 0);
      if (cancel === "stop") assert.match(screen.getByRole("alert").textContent ?? "", /transfer stopped/);
    } finally { cleanup(); client.clear(); }
  }
});
