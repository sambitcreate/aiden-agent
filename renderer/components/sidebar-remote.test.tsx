import assert from "node:assert/strict";
import test from "node:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DOMParser } from "@xmldom/xmldom";
import type { SidebarHost } from "../lib/sidebar-remote-groups";
import type { SidebarMachineFilter } from "../lib/sidebar-organization";
import {
  MachineBadges,
  MachineFilterChip,
  RemoteHostMarker,
  RemoteHostStatusList,
} from "./sidebar-remote";

const noop = () => undefined;
const reconnect = async () => undefined;

function parse(element: ReactElement) {
  const markup = renderToStaticMarkup(element);
  const document = new DOMParser().parseFromString(`<root>${markup}</root>`, "text/xml");
  const all = Array.from(document.getElementsByTagName("*"));
  const byRole = (role: string) => all.filter((node) => node.getAttribute("role") === role);
  const buttons = all.filter((node) => node.tagName === "button");
  return { markup, all, byRole, buttons };
}

test("the globe marker names the host it lives on, and says when that host is offline", () => {
  const live = parse(<RemoteHostMarker hostLabel="Studio (a1b2)" />).byRole("img");
  assert.equal(live.length, 1);
  assert.equal(live[0]?.getAttribute("aria-label"), "On Studio (a1b2)");
  assert.equal(live[0]?.getAttribute("title"), "On Studio (a1b2)");
  const stale = parse(<RemoteHostMarker hostLabel="Studio" stale />).byRole("img");
  assert.equal(stale[0]?.getAttribute("aria-label"), "On Studio, offline");
});

test("machine badges appear only when a group spans more than one machine", () => {
  assert.equal(renderToStaticMarkup(<MachineBadges labels={["This Mac"]} />), "");
  const { all } = parse(<MachineBadges labels={["This Mac", "Studio"]} />);
  const wrapper = all.find((node) => node.getAttribute("aria-label"));
  assert.equal(wrapper?.getAttribute("aria-label"), "On This Mac, Studio");
  assert.equal(wrapper?.textContent, "This MacStudio");
});

test("the filter chip shows the machine and offers a labelled way back to all machines", () => {
  const { all, buttons } = parse(<MachineFilterChip label="Laptop" onClear={noop} />);
  assert.ok(all.some((node) => node.textContent === "Laptop"));
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0]?.getAttribute("aria-label"), "Show all machines instead of Laptop only");
});

const hosts: SidebarHost[] = [
  { id: "studio", label: "Studio", availability: "online" },
  { id: "laptop", label: "Laptop", availability: "offline" },
  { id: "mini", label: "Mini", availability: "blocked", blockedReason: "auth" },
  { id: "air", label: "Air", availability: "connecting" },
];

function statusRows(filter: SidebarMachineFilter) {
  const { byRole } = parse(
    <RemoteHostStatusList hosts={hosts} filter={filter} onReconnect={reconnect} onManage={noop} />,
  );
  return byRole("status").map((row) => ({
    availability: row.getAttribute("data-host-availability"),
    text: row.textContent,
    actions: Array.from(row.getElementsByTagName("button")).map((button) =>
      button.getAttribute("aria-label"),
    ),
  }));
}

test("offline and blocked hosts get a status row with the matching recovery action", () => {
  assert.deepEqual(statusRows("all"), [
    {
      availability: "offline",
      text: "Laptop · OfflineReconnect",
      actions: ["Reconnect to Laptop"],
    },
    {
      availability: "blocked",
      text: "Mini · Needs re-pairing" + "Connections",
      actions: ["Open Connections to re-pair Mini"],
    },
  ]);
});

test("status rows follow the machine filter", () => {
  assert.deepEqual(
    statusRows("host:laptop").map((row) => row.availability),
    ["offline"],
  );
  assert.deepEqual(statusRows("host:studio"), []);
  assert.deepEqual(statusRows("local"), []);
  const nothingUnavailable = renderToStaticMarkup(
    <RemoteHostStatusList
      hosts={hosts.filter((host) => host.availability === "online")}
      filter="all"
      onReconnect={reconnect}
      onManage={noop}
    />,
  );
  assert.equal(nothingUnavailable, "");
});
