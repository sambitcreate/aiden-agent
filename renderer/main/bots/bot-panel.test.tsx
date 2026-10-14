import { installBotTestIpc } from "./test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BOT_PANEL_OPEN_KEY, BOT_PANEL_TAB_KEY, BotPanelProvider, useBotPanel } from "./bot-panel-context";

beforeEach(() => {
  installBotTestIpc();
  localStorage.clear();
});
afterEach(cleanup);

function PanelProbe() {
  const panel = useBotPanel();
  const request = panel.fileRequest ? `${panel.fileRequest.path}#${panel.fileRequest.key}` : "none";
  return (
    <>
      <output aria-label="Panel">{`${panel.open ? "open" : "closed"} ${panel.tab} ${request}`}</output>
      <button type="button" onClick={() => panel.show("files", { path: "lists/groceries.md" })}>
        Open groceries
      </button>
      <button type="button" onClick={() => panel.show("memory")}>
        Open memory
      </button>
      <button type="button" onClick={panel.toggle}>
        Toggle
      </button>
    </>
  );
}

const panelState = () => screen.getByRole("status", { name: "Panel" }).textContent ?? "";

test("a file asked for twice is two requests, and the toggle closes and reopens on the same tab", () => {
  render(
    <BotPanelProvider>
      <PanelProbe />
    </BotPanelProvider>,
  );
  assert.equal(panelState(), "closed activity none");
  fireEvent.click(screen.getByRole("button", { name: "Open groceries" }));
  const first = panelState();
  assert.match(first, /^open files lists\/groceries\.md#\d+$/u);
  fireEvent.click(screen.getByRole("button", { name: "Open groceries" }));
  assert.notEqual(panelState(), first, "the same chip clicked again selects its file again");
  fireEvent.click(screen.getByRole("button", { name: "Toggle" }));
  assert.match(panelState(), /^closed files /u);
  fireEvent.click(screen.getByRole("button", { name: "Toggle" }));
  assert.match(panelState(), /^open files /u);
});

test("the Bot panel comes back open on its last tab after a relaunch, under its own keys only", () => {
  const first = render(
    <BotPanelProvider>
      <PanelProbe />
    </BotPanelProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open memory" }));
  first.unmount();
  render(
    <BotPanelProvider>
      <PanelProbe />
    </BotPanelProvider>,
  );
  assert.equal(panelState(), "open memory none");
  assert.equal(localStorage.getItem(BOT_PANEL_OPEN_KEY), "true");
  assert.equal(localStorage.getItem(BOT_PANEL_TAB_KEY), "memory");
  for (const key of [
    "aiden-agent.environment.open",
    "aiden-agent.environment.open-tabs-v1",
    "aiden-agent.environment.tab",
    "aiden-agent.quick-view.open",
  ]) {
    assert.equal(localStorage.getItem(key), null, key);
  }
});

test("a saved tab this build doesn't know, or a garbled open flag, opens closed on Activity", () => {
  localStorage.setItem(BOT_PANEL_TAB_KEY, "browser");
  localStorage.setItem(BOT_PANEL_OPEN_KEY, "yes");
  render(
    <BotPanelProvider>
      <PanelProbe />
    </BotPanelProvider>,
  );
  assert.equal(panelState(), "closed activity none");
});
