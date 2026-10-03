import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DOMParser } from "@xmldom/xmldom";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { SidebarOrganizeMenuItems, type SidebarOrganizeMenuItemsProps } from "./sidebar-organize-menu";

const noop = () => undefined;

/** Renders the menu open in place (no portal) and returns each radio group. */
function renderMenu(overrides: Partial<SidebarOrganizeMenuItemsProps> = {}) {
  const markup = renderToStaticMarkup(
    <DropdownMenuPrimitive.Root open modal={false}>
      <DropdownMenuPrimitive.Trigger>Organize sidebar</DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Content>
        <SidebarOrganizeMenuItems
          view="projects"
          chatSort="last_activity"
          projectSort="last_activity"
          onViewChange={noop}
          onChatSortChange={noop}
          onProjectSortChange={noop}
          {...overrides}
        />
      </DropdownMenuPrimitive.Content>
    </DropdownMenuPrimitive.Root>,
  );
  const document = new DOMParser().parseFromString(`<root>${markup}</root>`, "text/xml");
  const all = Array.from(document.getElementsByTagName("*"));
  return all
    .filter((element) => element.getAttribute("role") === "group")
    .map((group) => {
      const labelId = group.getAttribute("aria-labelledby");
      const label = all.find((element) => element.getAttribute("id") === labelId);
      const items = Array.from(group.getElementsByTagName("*")).filter(
        (element) => element.getAttribute("role") === "menuitemradio",
      );
      return {
        label: label?.textContent ?? null,
        options: items.map((item) => item.textContent),
        checked: items
          .filter((item) => item.getAttribute("aria-checked") === "true")
          .map((item) => item.textContent),
      };
    });
}

test("workspace view offers every view and both sort choices with the current values checked", () => {
  assert.deepEqual(renderMenu({ chatSort: "created", projectSort: "manual" }), [
    { label: "View", options: ["Workspaces", "Recent", "Needs attention"], checked: ["Workspaces"] },
    { label: "Sort chats", options: ["Last activity", "Created"], checked: ["Created"] },
    {
      label: "Sort workspaces",
      options: ["Last activity", "Created", "Manual"],
      checked: ["Manual"],
    },
  ]);
});

test("sort groups appear only for the views they affect", () => {
  assert.deepEqual(
    renderMenu({ view: "recent" }).map((group) => [group.label, group.checked]),
    [
      ["View", ["Recent"]],
      ["Sort chats", ["Last activity"]],
    ],
  );
  assert.deepEqual(
    renderMenu({ view: "attention" }).map((group) => [group.label, group.checked]),
    [["View", ["Needs attention"]]],
  );
});

const machines = {
  hosts: [
    { id: "studio", label: "Studio" },
    { id: "laptop", label: "Laptop" },
  ],
  filter: "host:laptop" as const,
  grouping: "repository" as const,
  onFilterChange: noop,
  onGroupingChange: noop,
};

test("with paired hosts the menu offers a machine filter and, for workspaces, cross-machine grouping", () => {
  const groups = renderMenu({ machines });
  assert.deepEqual(groups.slice(3), [
    {
      label: "Machines",
      options: ["All machines", "This Mac", "Studio", "Laptop"],
      checked: ["Laptop"],
    },
    {
      label: "Group across machines",
      options: ["Keep separate", "Same repository", "Same repository and path"],
      checked: ["Same repository"],
    },
  ]);
  // Grouping applies to workspaces only; the machine filter stays for every view.
  assert.deepEqual(
    renderMenu({ view: "attention", machines }).map((group) => group.label),
    ["View", "Machines"],
  );
});

test("without paired hosts the menu has no machine choices", () => {
  assert.deepEqual(
    renderMenu({ machines: { ...machines, hosts: [] } }).map((group) => group.label),
    ["View", "Sort chats", "Sort workspaces"],
  );
});
