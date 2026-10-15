import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { emitBotTestNotification, installBotTestIpc } from "../../main/bots/test-dom";
import { createBotTestQueryClient } from "../../main/bots/test-providers";
import {
  AppCapabilitiesProvider,
  DISABLED_APP_CAPABILITIES,
  type AppCapabilities,
} from "../../lib/app-capabilities";
import type {
  AidenRemoteBeginPairingResult,
  AidenRemoteDeviceView,
  AidenRemotePairingBootstrapView,
  AidenRemoteSettingsSnapshot,
  AidenRemoteStatusView,
} from "../../shared/aiden-remote";
import { Toaster, toast } from "../ui";
import { RemoteAccessSettings } from "./remote-access-settings";

// Never a legitimate piece of UI copy: any appearance in the DOM is a leak.
const PAIRING_SECRET = "SENTINEL-PAIRING-SECRET-7f3c9a";
const MANUAL_CODE = "ABCD-EFGH-JKLM";
const INSTANCE_ID = "instance-0000-4a1b2c";

let clipboard: string[] = [];

beforeEach(() => {
  clipboard = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => void clipboard.push(text) },
  });
});

afterEach(() => {
  toast.dismiss();
  cleanup();
});

function status(overrides: Partial<AidenRemoteStatusView> = {}): AidenRemoteStatusView {
  return {
    enabled: true,
    running: true,
    connectionMode: "lan",
    lanPort: 48_100,
    lanEndpoint: "https://192.168.1.20:48100/api/aiden/v1",
    tailscaleConnected: false,
    tailscaleInstalled: true,
    tailscaleRouteState: "available",
    pairedDeviceCount: 0,
    approvedRootCount: 0,
    ...overrides,
  };
}

function snapshotWith(overrides: Partial<AidenRemoteSettingsSnapshot> = {}): AidenRemoteSettingsSnapshot {
  return {
    instanceId: INSTANCE_ID,
    displayName: "Studio Mac",
    status: status(),
    devices: [],
    approvedRoots: [],
    ...overrides,
  };
}

function device(overrides: Partial<AidenRemoteDeviceView> = {}): AidenRemoteDeviceView {
  return {
    id: "device-1",
    name: "Sam's iPhone",
    type: "iphone",
    clientVersion: "1.0.0",
    capabilities: [],
    createdAt: Date.now() - 60_000,
    lastSeenAt: Date.now() - 1_000,
    ...overrides,
  };
}

function bootstrap(sessionId: string, endpoint = "https://192.168.1.20:48100/api/aiden/v1"): AidenRemotePairingBootstrapView {
  return {
    pairingSessionId: sessionId,
    protocolVersion: 1,
    instanceId: INSTANCE_ID,
    endpoint,
    serverSpkiSha256: "0123456789abcdef0123456789abcdef",
    secret: PAIRING_SECRET,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    // The real scanner envelope carries the secret; it must reach the page only as QR pixels.
    qrPayload: JSON.stringify({ v: 1, endpoint, secret: PAIRING_SECRET }),
    manualCode: MANUAL_CODE,
  };
}

type Handler = (...args: unknown[]) => unknown;

/** A fake main process for Remote Access: mutations update the snapshot `remote:get` serves. */
function remoteServer(initial: AidenRemoteSettingsSnapshot, overrides: Record<string, Handler> = {}) {
  let snapshot = structuredClone(initial);
  let sessions = 0;
  const pair = (transport: unknown): AidenRemoteBeginPairingResult => {
    const next = bootstrap(
      `pairing-${++sessions}`,
      transport === "tailscale" ? "https://studio.tailnet.ts.net/api/aiden/v1" : undefined,
    );
    snapshot = { ...snapshot, pairing: { sessionId: next.pairingSessionId, state: "awaiting_scan" } };
    return next;
  };
  const update = (change: (current: AidenRemoteSettingsSnapshot) => AidenRemoteSettingsSnapshot) => {
    snapshot = change(snapshot);
    return structuredClone(snapshot);
  };
  const calls = installBotTestIpc({
    "remote:get": () => structuredClone(snapshot),
    "remote:beginPairing": pair,
    "remote:setupPairing": (transport) => {
      snapshot = { ...snapshot, status: { ...snapshot.status, enabled: true, running: true } };
      return pair(transport);
    },
    "remote:closePairing": () => {
      snapshot = { ...snapshot, pairing: undefined };
      return { closed: true };
    },
    "remote:setEnabled": (enabled) =>
      update((current) => ({ ...current, status: { ...current.status, enabled: enabled as boolean } })),
    "remote:setDisplayName": (displayName) =>
      update((current) => ({ ...current, displayName: displayName as string })),
    "remote:revokeDevice": (id) =>
      update((current) => ({
        ...current,
        devices: current.devices.map((entry) => (entry.id === id ? { ...entry, revokedAt: Date.now() } : entry)),
      })),
    "remote:addApprovedRoot": () =>
      update((current) => ({
        ...current,
        approvedRoots: [...current.approvedRoots, { id: "root-new", label: "Notes", folderPath: "/Users/sam/Notes", createdAt: 1 }],
      })),
    "remote:removeApprovedRoot": (id) =>
      update((current) => ({ ...current, approvedRoots: current.approvedRoots.filter((root) => root.id !== id) })),
    "remote:moveToAvailablePort": () =>
      update((current) => ({
        ...current,
        status: { ...current.status, lanPort: 48_101, errorCode: undefined, error: undefined, running: true },
      })),
    "remote:tailscaleReviewTakeover": () => ({ token: "takeover-token", expiresAt: Date.now() + 60_000 }),
    "remote:tailscaleTakeOver": () =>
      update((current) => ({
        ...current,
        status: { ...current.status, tailscaleRouteState: "owned", tailscaleConnected: true },
      })),
    "remote:tailscaleReconcile": () =>
      update((current) => ({ ...current, status: { ...current.status, tailscaleRouteState: "owned" } })),
    ...overrides,
  });
  return {
    calls: (channel: string) => calls.filter((call) => call.channel === channel),
    /** Changes main-process state and announces it the way main does. */
    async push(change: (current: AidenRemoteSettingsSnapshot) => AidenRemoteSettingsSnapshot) {
      snapshot = change(snapshot);
      await act(async () => emitBotTestNotification("remote:changed", undefined));
    },
  };
}

function mount(capabilities: Partial<AppCapabilities> = {}) {
  return render(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <AppCapabilitiesProvider capabilities={{ ...DISABLED_APP_CAPABILITIES, platform: "darwin", ...capabilities }}>
        <RemoteAccessSettings />
      </AppCapabilitiesProvider>
      <Toaster />
    </QueryClientProvider>,
  );
}

/**
 * Absence check. Comparing a node with `assert.equal(node, null)` would make
 * every failing waitFor retry inspect the whole happy-dom graph, which stalls.
 */
function absent(element: Element | null): boolean {
  return element === null;
}

/** Every string the page exposes: rendered text plus every attribute value. */
function renderedSurface(): string {
  const parts = [document.body.textContent ?? ""];
  for (const element of document.querySelectorAll("*")) {
    for (const attribute of Array.from(element.attributes)) parts.push(attribute.value);
  }
  return parts.join("\n");
}

async function openPairingDialog() {
  fireEvent.click(await screen.findByRole("button", { name: /Connect a device|Add device/u }));
  return screen.findByRole("dialog", { name: "Pair Aiden On The Go" });
}

test("pairing shows the address and setup code, copies the code, and never renders the secret", async () => {
  const server = remoteServer(snapshotWith());
  mount();

  const dialog = await openPairingDialog();
  assert.deepEqual(server.calls("remote:beginPairing").map((call) => call.args), [["lan"]]);
  assert.match(dialog.textContent ?? "", /Nearby desktop address/u);
  assert.match(dialog.textContent ?? "", /192\.168\.1\.20/u);
  assert.match(dialog.textContent ?? "", new RegExp(MANUAL_CODE, "u"));
  // The certificate check is derived from the server fingerprint, not the secret.
  assert.match(dialog.textContent ?? "", /Certificate check 789ABCDE/u);
  assert.match(dialog.textContent ?? "", /Expires in/u);
  await waitFor(() => assert.ok(within(dialog).getByRole("img", { name: "One-time Aiden pairing QR code" })));

  fireEvent.click(within(dialog).getByRole("button", { name: "Copy setup code" }));
  await waitFor(() => assert.deepEqual(clipboard, [MANUAL_CODE]));
  fireEvent.click(within(dialog).getByRole("button", { name: "Copy desktop address" }));
  await waitFor(() => assert.deepEqual(clipboard, [MANUAL_CODE, "https://192.168.1.20:48100/api/aiden/v1"]));

  assert.equal(renderedSurface().includes(PAIRING_SECRET), false, "the pairing secret leaked into the DOM");
});

test("a Tailscale-only desktop pairs over its private address", async () => {
  const server = remoteServer(snapshotWith({
    status: status({ connectionMode: "tailscale", tailscaleConnected: true, tailscaleRouteState: "owned" }),
  }));
  mount();

  const dialog = await openPairingDialog();
  assert.deepEqual(server.calls("remote:beginPairing").map((call) => call.args), [["tailscale"]]);
  assert.match(dialog.textContent ?? "", /Private Tailscale address/u);
  assert.match(dialog.textContent ?? "", /studio\.tailnet\.ts\.net/u);
  assert.equal(renderedSurface().includes(PAIRING_SECRET), false);
});

test("a consumed code hides the setup code, then a connected device closes pairing and is announced", async () => {
  const server = remoteServer(snapshotWith());
  mount();
  const dialog = await openPairingDialog();

  await server.push((current) => ({
    ...current,
    pairing: { sessionId: "pairing-1", state: "finishing", deviceId: "device-1" },
    devices: [device({ lastSeenAt: 0 })],
  }));
  await waitFor(() => assert.match(dialog.textContent ?? "", /Code unavailable/u));
  assert.doesNotMatch(dialog.textContent ?? "", new RegExp(MANUAL_CODE, "u"));
  assert.ok(absent(within(dialog).queryByRole("button", { name: "Copy setup code" })));
  assert.match(dialog.textContent ?? "", /Finishing connection/u);
  assert.ok(within(dialog).getAllByRole("status").length > 0, "progress is announced to assistive tech");

  await server.push((current) => ({ ...current, devices: [device()] }));
  await waitFor(() => assert.ok(absent(screen.queryByRole("dialog", { name: "Pair Aiden On The Go" }))));
  assert.deepEqual(server.calls("remote:closePairing").map((call) => call.args), [["pairing-1"]]);
  assert.ok(await screen.findByText("Sam's iPhone connected."));
  assert.ok(document.querySelector('[data-remote-device-id="device-1"]'));
  assert.equal(renderedSurface().includes(PAIRING_SECRET), false);
});

test("a failed pairing offers a fresh code on the same transport", async () => {
  const server = remoteServer(snapshotWith());
  mount();
  const dialog = await openPairingDialog();

  await server.push((current) => ({ ...current, pairing: { sessionId: "pairing-1", state: "failed" } }));
  const retry = await within(dialog).findByRole("button", { name: "Create new code" });
  assert.match(dialog.textContent ?? "", /Pairing failed/u);
  fireEvent.click(retry);
  await waitFor(() => assert.equal(server.calls("remote:beginPairing").length, 2));
  assert.deepEqual(server.calls("remote:beginPairing")[1]?.args, ["lan"]);
  await waitFor(() => assert.match(dialog.textContent ?? "", new RegExp(MANUAL_CODE, "u")));
});

test("a pairing window replaced elsewhere closes with an explanation", async () => {
  const server = remoteServer(snapshotWith());
  mount();
  await openPairingDialog();

  await server.push((current) => ({ ...current, pairing: { sessionId: "pairing-other", state: "awaiting_scan" } }));
  await waitFor(() => assert.ok(absent(screen.queryByRole("dialog", { name: "Pair Aiden On The Go" }))));
  assert.ok(await screen.findByText("This pairing code was replaced by a newer pairing window."));
});

test("unmounting Settings closes an open pairing window", async () => {
  const server = remoteServer(snapshotWith());
  const view = mount();
  await openPairingDialog();

  view.unmount();
  await waitFor(() => assert.deepEqual(server.calls("remote:closePairing").map((call) => call.args), [["pairing-1"]]));
});

test("an unreachable TLS endpoint is reported without opening a pairing window", async () => {
  remoteServer(snapshotWith(), {
    "remote:beginPairing": () => ({ ok: false, code: "unreachable", message: "Your phone couldn't reach this desktop." }),
  });
  mount();

  fireEvent.click(await screen.findByRole("button", { name: "Connect a device" }));
  assert.ok(await screen.findByText("Your phone couldn't reach this desktop."));
  assert.ok(absent(screen.queryByRole("dialog", { name: "Pair Aiden On The Go" })));
});

test("a Tailscale permission failure shows the operator remediation without IPC noise", async () => {
  remoteServer(snapshotWith({
    status: status({ connectionMode: "tailscale", tailscaleConnected: true, tailscaleRouteState: "owned" }),
  }), {
    "remote:beginPairing": () => {
      throw new Error("Error invoking remote method 'remote:beginPairing': Error: tailscale_permission_denied");
    },
  });
  mount();

  fireEvent.click(await screen.findByRole("button", { name: "Connect a device" }));
  const alert = await screen.findByRole("alert");
  assert.match(alert.textContent ?? "", /sudo tailscale set --operator=\$USER/u);
  assert.doesNotMatch(alert.textContent ?? "", /Error invoking|tailscale_permission_denied/u);
});

test("guided setup confirms the change and sends the snapshot it was reviewed against", async () => {
  const server = remoteServer(snapshotWith({ status: status({ enabled: false, running: false }) }));
  mount({ bots: true });

  assert.match(
    (await screen.findByText(/from your phone or tablet/u)).textContent ?? "",
    /Bots and workspaces .* this Mac/u,
  );
  fireEvent.click(screen.getByRole("radio", { name: /On the same Wi-Fi/u }));
  fireEvent.click(screen.getByRole("button", { name: "Connect a device" }));

  const review = await screen.findByRole("dialog", { name: "Connect your phone to this Mac?" });
  const copy = review.textContent ?? "";
  assert.match(copy, /Your AI keys stay on this Mac/u);
  assert.match(copy, /phone access stays on until you turn it off/u);
  assert.match(copy, /and Bot access stay unchanged/u);
  assert.equal(server.calls("remote:setupPairing").length, 0, "nothing changes before confirmation");

  fireEvent.click(within(review).getByRole("button", { name: "Enable and show code" }));
  await screen.findByRole("dialog", { name: "Pair Aiden On The Go" });
  assert.deepEqual(server.calls("remote:setupPairing").map((call) => call.args), [
    ["lan", { transport: "lan", instanceId: INSTANCE_ID, enabled: false, connectionMode: "lan" }],
  ]);
});

test("guided setup on a non-Mac host without Bots advertises only workspaces", async () => {
  remoteServer(snapshotWith({ status: status({ enabled: false, running: false }) }));
  mount({ platform: "linux", bots: false });

  const intro = (await screen.findByText(/from your phone or tablet/u)).textContent ?? "";
  assert.match(intro, /Use your workspaces from/u);
  assert.match(intro, /this computer/u);
  fireEvent.click(screen.getByRole("button", { name: "Connect a device" }));
  const review = await screen.findByRole("dialog", { name: "Connect your phone to this computer?" });
  assert.doesNotMatch(review.textContent ?? "", /Bot access/u);
});

test("a setup failure stays visible inside the review dialog", async () => {
  remoteServer(snapshotWith({ status: status({ enabled: false, running: false }) }), {
    "remote:setupPairing": () => {
      throw new Error("Error invoking remote method 'remote:setupPairing': Error: tailscale_not_connected");
    },
  });
  mount();

  fireEvent.click(await screen.findByRole("button", { name: "Connect a device" }));
  const review = await screen.findByRole("dialog", { name: /Connect your phone/u });
  fireEvent.click(within(review).getByRole("button", { name: "Enable and show code" }));
  await waitFor(() =>
    assert.match(within(review).getByRole("alert").textContent ?? "", /Open Tailscale and sign in before connecting Aiden\./u),
  );
});

test("a local-only service with Tailscale signed out explains what is ready and how to fix the route", async () => {
  remoteServer(snapshotWith({
    status: status({
      connectionMode: "both",
      tailscaleRouteState: "unavailable",
      tailscaleErrorCode: "not_connected",
    }),
  }));
  mount();

  const page = await screen.findByText(/Local Network \+ Tailscale · Local ready · Sign in required/u);
  assert.ok(page);
  assert.ok(screen.getByText("Local service ready"));
  assert.ok(screen.getByText("Open Tailscale and sign in before connecting Aiden’s mobile route."));
  assert.ok(screen.getByText(/never enables Funnel, and never resets unrelated routes/u));
});

test("an HTTPS-less Tailscale name and a missing install each name their fix", async () => {
  remoteServer(snapshotWith({
    status: status({ connectionMode: "tailscale", tailscaleRouteState: "unavailable", tailscaleErrorCode: "https_unavailable" }),
  }));
  mount();
  assert.ok(await screen.findByText("Enable HTTPS for this Tailscale device name, then try again."));
  cleanup();

  remoteServer(snapshotWith({
    status: status({ connectionMode: "tailscale", tailscaleRouteState: "unavailable", tailscaleInstalled: false, tailscaleErrorCode: "not_installed" }),
  }));
  mount();
  assert.ok(await screen.findByText("Install Tailscale to use this connection method."));
  assert.ok(screen.getByText("Tailscale not found"));
});

test("a stale Aiden route is taken over only after an explicit, bounded review", async () => {
  const server = remoteServer(snapshotWith({
    status: status({ connectionMode: "tailscale", tailscaleRouteState: "other_aiden_stale" }),
  }));
  mount();

  fireEvent.click(await screen.findByRole("button", { name: "Review takeover" }));
  const review = await screen.findByRole("alertdialog", { name: "Take over Aiden’s mobile route?" });
  assert.match(review.textContent ?? "", /replace only \/api\/aiden\/v1/u);
  assert.match(review.textContent ?? "", /preserve every other Serve handler/u);
  assert.equal(server.calls("remote:tailscaleTakeOver").length, 0);

  fireEvent.click(within(review).getByRole("button", { name: "Take Over" }));
  assert.ok(await screen.findByText("This Aiden profile now owns the mobile route."));
  assert.deepEqual(server.calls("remote:tailscaleTakeOver").map((call) => call.args), [["takeover-token"]]);
  await waitFor(() => assert.ok(absent(screen.queryByRole("alertdialog"))));
  assert.ok(screen.getByRole("button", { name: "Disconnect" }));
});

test("a takeover that lost the race explains it in plain words", async () => {
  remoteServer(snapshotWith({
    status: status({ connectionMode: "tailscale", tailscaleRouteState: "other_aiden_stale" }),
  }), {
    "remote:tailscaleTakeOver": () => {
      throw new Error("Error invoking remote method 'remote:tailscaleTakeOver': Error: tailscale_route_live");
    },
  });
  mount();

  fireEvent.click(await screen.findByRole("button", { name: "Review takeover" }));
  const review = await screen.findByRole("alertdialog");
  fireEvent.click(within(review).getByRole("button", { name: "Take Over" }));
  assert.ok(await screen.findByText("Another Aiden profile is active on this route. Nothing was changed."));
});

test("a live route owned by another profile is disclosed with no takeover action", async () => {
  remoteServer(snapshotWith({
    status: status({ connectionMode: "tailscale", tailscaleRouteState: "other_aiden_live" }),
  }));
  mount();

  assert.ok(await screen.findByText(/Another running Aiden profile owns this desktop’s mobile route/u));
  assert.ok(absent(screen.queryByRole("button", { name: "Review takeover" })));
});

test("an uncertain Tailscale update requires an explicit verification", async () => {
  const server = remoteServer(snapshotWith({
    status: status({ connectionMode: "tailscale", tailscaleRouteState: "reconciliation_required" }),
  }));
  mount();

  assert.ok(await screen.findByText("Verification needed"));
  fireEvent.click(screen.getByRole("button", { name: "Verify update" }));
  await waitFor(() => assert.equal(server.calls("remote:tailscaleReconcile").length, 1));
  await waitFor(() => assert.ok(absent(screen.queryByRole("button", { name: "Verify update" }))));
});

test("a saved endpoint collision is never moved silently", async () => {
  const server = remoteServer(snapshotWith({
    status: status({
      running: false,
      errorCode: "remote_port_in_use",
      error: "Remote Access couldn't start because its saved port is in use.",
    }),
  }));
  mount();

  assert.ok(await screen.findByText(/Another local Aiden profile is using this saved endpoint/u));
  assert.ok(screen.getByText(/Aiden will never move a saved mobile connection silently/u));
  fireEvent.click(screen.getByRole("button", { name: "Use another port" }));
  const review = await screen.findByRole("alertdialog", { name: "Move this Remote Access endpoint?" });
  assert.match(review.textContent ?? "", /Previously paired devices may need to discover this desktop again/u);
  assert.equal(server.calls("remote:moveToAvailablePort").length, 0);

  fireEvent.click(within(review).getByRole("button", { name: "Use Another Port" }));
  await waitFor(() => assert.equal(server.calls("remote:moveToAvailablePort").length, 1));
  await waitFor(() => assert.ok(absent(screen.queryByRole("alertdialog"))));
  assert.ok(screen.getByText(/Private API port 48101/u));
});

test("the enable switch and desktop name write through to main", async () => {
  const server = remoteServer(snapshotWith());
  mount();

  const toggle = await screen.findByRole("switch", { name: "Enable Aiden Remote Access" });
  fireEvent.click(toggle);
  await waitFor(() => assert.deepEqual(server.calls("remote:setEnabled").map((call) => call.args), [[false]]));

  assert.ok(screen.getByText(/Identity remains 4a1b2c\./u));
  const name = screen.getByRole("textbox", { name: "Desktop display name" }) as HTMLInputElement;
  assert.equal(name.maxLength, 80);
  const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
  assert.equal(save.disabled, true, "an unchanged name has nothing to save");
  fireEvent.change(name, { target: { value: "Desk Mac" } });
  await waitFor(() => assert.equal(save.disabled, false));
  fireEvent.click(save);
  await waitFor(() => assert.deepEqual(server.calls("remote:setDisplayName").map((call) => call.args), [["Desk Mac"]]));
});

test("removing a device asks first and moves it to previous connections", async () => {
  const server = remoteServer(snapshotWith({
    devices: [device(), device({ id: "device-old", name: "Old iPad", type: "ipad", revokedAt: Date.now() - 1_000 })],
  }));
  mount();

  const row = await waitFor(() => {
    const element = document.querySelector<HTMLElement>('[data-remote-device-id="device-1"]');
    assert.ok(element);
    return element;
  });
  assert.match(row.textContent ?? "", /Active/u);
  assert.ok(screen.getByText("Previous connections"));
  // With a saved device, both the setup card and the device list offer to add another.
  assert.equal(screen.getAllByRole("button", { name: "Add device" }).length, 2);
  assert.ok(absent(screen.queryByRole("button", { name: "Connect a device" })));

  fireEvent.click(within(row).getByRole("button", { name: "Remove access" }));
  const review = await screen.findByRole("alertdialog", { name: "Remove this device’s access?" });
  assert.match(review.textContent ?? "", /“Sam's iPhone” will immediately lose Remote Access/u);
  fireEvent.click(within(review).getByRole("button", { name: "Remove access" }));
  await waitFor(() => assert.deepEqual(server.calls("remote:revokeDevice").map((call) => call.args), [["device-1"]]));
  await waitFor(() => assert.ok(absent(screen.queryByRole("button", { name: "Remove access" }))));
});

test("approved folders are added and removed through main without touching workspaces", async () => {
  const server = remoteServer(snapshotWith({
    approvedRoots: [{ id: "root-1", label: "Projects", folderPath: "/Users/sam/Projects", createdAt: 1 }],
  }));
  mount();

  assert.ok(await screen.findByText(/Paired devices can explore only these roots/u));
  fireEvent.click(screen.getByRole("button", { name: "Add folder" }));
  assert.ok(await screen.findByText("Notes"));
  assert.equal(server.calls("remote:addApprovedRoot").length, 1);

  fireEvent.click(screen.getByRole("button", { name: "Remove Projects" }));
  const review = await screen.findByRole("alertdialog", { name: "Remove this approved folder?" });
  assert.match(review.textContent ?? "", /Existing Aiden workspaces are unchanged/u);
  fireEvent.click(within(review).getByRole("button", { name: "Remove" }));
  await waitFor(() => assert.deepEqual(server.calls("remote:removeApprovedRoot").map((call) => call.args), [["root-1"]]));
  await waitFor(() => assert.ok(absent(screen.queryByText("/Users/sam/Projects"))));
});
