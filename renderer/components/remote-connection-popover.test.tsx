import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DeviceRow } from "./remote-connection-popover";
import type { AidenRemoteDeviceView } from "../shared/aiden-remote";
const device = (type: AidenRemoteDeviceView["type"]): AidenRemoteDeviceView => ({
  id: "device_1", name: "Travel device", type, createdAt: 1_800_000_000_000,
  lastSeenAt: 0, capabilities: [], clientVersion: "1.0",
});

test("a pending device explains first contact without showing an epoch timestamp", () => {
  const html = renderToStaticMarkup(<DeviceRow device={device("iphone")} state="pending" />);
  assert.match(html, /Finishing connection/);
  assert.match(html, /Waiting for the first authenticated connection/);
  assert.doesNotMatch(html, /1970|Last seen/);
});

test("Android and desktop pairings have their own accessible device identity", () => {
  const android = renderToStaticMarkup(<DeviceRow device={device("android")} state="pending" />);
  assert.match(android, /Android device/);
  assert.doesNotMatch(android, /iPhone|iPad/);
  assert.match(renderToStaticMarkup(<DeviceRow device={device("linux")} state="pending" />), /Linux/);
});

test("the sidebar connection action names all devices and reports recent activity accurately", async () => {
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { RemoteConnectionPopover } = await import("./remote-connection-popover");
  const { queryKeys } = await import("../lib/queries");
  const client = new QueryClient();
  client.setQueryData(queryKeys.aidenRemote, {
    devices: [{ ...device("android"), lastSeenAt: Date.now() }],
    status: { enabled: true, running: true },
  });
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><RemoteConnectionPopover onManage={() => {}} /></QueryClientProvider>);
  assert.match(html, /aria-label="Device connections · 1 recently active"/);
  assert.doesNotMatch(html, /Mobile connections/);
  client.clear();
});
