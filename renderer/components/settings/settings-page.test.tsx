import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { availableSettingsPages, pageFor, type SettingsSection } from "../../lib/settings-section";
import { SettingsPageTabs } from "./settings-page";

afterEach(cleanup);

function Harness({ initial, onSelect }: { initial: SettingsSection; onSelect?: (section: SettingsSection) => void }) {
  const [section, setSection] = React.useState(initial);
  return (
    <SettingsPageTabs
      page={pageFor(section)}
      section={section}
      onSelect={(next) => {
        onSelect?.(next);
        setSection(next);
      }}
    >
      <p>Content for {section}</p>
    </SettingsPageTabs>
  );
}

test("a merged page names its tablist and links the selected tab to the panel", () => {
  render(<Harness initial="peerHosts" />);
  const tablist = screen.getByRole("tablist", { name: "Connections" });
  assert.ok(tablist);
  const tabs = screen.getAllByRole("tab");
  assert.deepEqual(tabs.map((tab) => tab.textContent), ["Control this device", "Control other devices", "Apps using Aiden", "Telegram"]);
  const selected = screen.getByRole("tab", { selected: true });
  assert.equal(selected.textContent, "Control other devices");
  const panel = screen.getByRole("tabpanel", { name: "Control other devices" });
  assert.equal(selected.getAttribute("aria-controls"), panel.id);
  // Only the selected panel exists, so no other tab may point at one.
  for (const tab of tabs.filter((item) => item !== selected)) {
    assert.equal(tab.getAttribute("aria-controls"), null);
  }
  assert.match(panel.textContent ?? "", /Content for peerHosts/u);
});

test("clicking a tab selects its section and shows only that panel", () => {
  const selected: SettingsSection[] = [];
  render(<Harness initial="voice" onSelect={(section) => selected.push(section)} />);
  const tab = screen.getByRole("tab", { name: "Text to Speech" });
  fireEvent.mouseDown(tab, { button: 0 });
  assert.deepEqual(selected, ["tts"]);
  assert.equal(screen.getAllByRole("tabpanel").length, 1);
  assert.match(screen.getByRole("tabpanel").textContent ?? "", /Content for tts/u);
});

test("a merged page left with one tab on this host drops the strip and takes the tab's name", () => {
  const page = availableSettingsPages({ computerUse: true, devices: true, botComputers: false, hooks: true, mcpServer: true }).find(
    (entry) => entry.id === pageFor("computerUse").id,
  );
  assert.ok(page);
  assert.equal(page.title, "Computer Use");
  render(
    <SettingsPageTabs page={page} section="computerUse" onSelect={() => {}}>
      <p>Content for computerUse</p>
    </SettingsPageTabs>,
  );
  assert.equal(screen.queryByRole("tablist"), null);
  assert.ok(screen.getByText("Content for computerUse"));
});

test("a page with one tab shows its content with no tab strip", () => {
  render(<Harness initial="memory" />);
  assert.equal(screen.queryByRole("tablist"), null);
  assert.equal(screen.queryByRole("tabpanel"), null);
  assert.ok(screen.getByText("Content for memory"));
});
