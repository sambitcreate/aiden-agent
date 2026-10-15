import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DOMParser } from "@xmldom/xmldom";
import { SidebarPrimaryNav, type SidebarPrimaryNavProps } from "./sidebar-primary-nav";

const noop = () => undefined;
const ALL = { bots: true, designStudio: true, createImages: true };

function render(overrides: Partial<SidebarPrimaryNavProps> = {}) {
  const markup = renderToStaticMarkup(
    <SidebarPrimaryNav
      pathname="/chat/chat-1"
      capabilities={{ bots: true, designStudio: false, createImages: false }}
      newAgentDisabled={false}
      onNewAgent={noop}
      onNavigate={noop}
      {...overrides}
    />,
  );
  const document = new DOMParser().parseFromString(`<root>${markup}</root>`, "text/xml");
  const nav = Array.from(document.getElementsByTagName("nav"));
  const rows = Array.from(document.getElementsByTagName("button")).map((button) => ({
    title: button.textContent,
    current: button.getAttribute("aria-current"),
    disabled: button.hasAttribute("disabled"),
  }));
  return { label: nav[0]?.getAttribute("aria-label") ?? null, navCount: nav.length, rows };
}

test("with both flags off the nav is exactly New Agent, Scheduled, Bots", () => {
  const { label, navCount, rows } = render();
  assert.equal(navCount, 1);
  assert.equal(label, "Primary");
  assert.deepEqual(
    rows.map(({ title }) => title),
    ["New Agent", "Scheduled", "Bots"],
  );
  assert.deepEqual(
    render({ capabilities: { bots: false, designStudio: false, createImages: false } }).rows.map(
      ({ title }) => title,
    ),
    ["New Agent", "Scheduled"],
  );
});

test("each studio row appears only with its own capability, after the existing rows", () => {
  const titles = (capabilities: SidebarPrimaryNavProps["capabilities"]) =>
    render({ capabilities }).rows.map(({ title }) => title);
  assert.deepEqual(titles({ bots: true, designStudio: true, createImages: false }), [
    "New Agent",
    "Scheduled",
    "Bots",
    "Design",
  ]);
  assert.deepEqual(titles({ bots: false, designStudio: false, createImages: true }), [
    "New Agent",
    "Scheduled",
    "Images",
  ]);
  assert.deepEqual(titles(ALL), ["New Agent", "Scheduled", "Bots", "Design", "Images"]);
});

test("the current row follows the path, including nested studio routes", () => {
  const current = (pathname: string) =>
    render({ pathname, capabilities: ALL })
      .rows.filter(({ current }) => current === "page")
      .map(({ title }) => title);
  assert.deepEqual(current("/design"), ["Design"]);
  assert.deepEqual(current("/design/project-1"), ["Design"]);
  assert.deepEqual(current("/images/workflow-1"), ["Images"]);
  assert.deepEqual(current("/bots/bot-1"), ["Bots"]);
  assert.deepEqual(current("/scheduled"), ["Scheduled"]);
  assert.deepEqual(current("/chat/chat-1"), []);
});

test("New Agent reflects its disabled state and nothing else is disabled", () => {
  const { rows } = render({ newAgentDisabled: true, capabilities: ALL });
  assert.deepEqual(
    rows.filter(({ disabled }) => disabled).map(({ title }) => title),
    ["New Agent"],
  );
});
