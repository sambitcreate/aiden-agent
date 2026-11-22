import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { installBotTestIpc } from "../../main/bots/test-dom";
import { mountWithBotRouter } from "../../main/bots/test-providers";
import type { ScheduledTaskSettings } from "../../lib/types";
import { ScheduledTasksSettings } from "./scheduled-tasks-settings";

function last<T>(items: readonly T[]): T | undefined {
  return items[items.length - 1];
}

afterEach(cleanup);

const stored: ScheduledTaskSettings = {
  enabled: true,
  defaultMode: "llm",
  defaultPermission: "read-only",
  defaultMcpEnabled: false,
  defaultNotify: true,
  defaultTimezone: "UTC",
  keepAwakeWhileWorking: true,
  chatCheckBacks: true,
};

async function mount(initial: ScheduledTaskSettings = stored) {
  let current = initial;
  const calls = installBotTestIpc({
    "schedule:list": () => [],
    "mcp:list": () => [],
    "schedule:keepAwakeStatus": () => ({ supported: true, enabled: true, holding: false, pausedWhileIdle: false, counts: {} }),
    "schedule:settings": (patch?: unknown) => (current = patch ? { ...current, ...(patch as object) } : current),
  });
  await mountWithBotRouter(<ScheduledTasksSettings />, { initialPath: "/settings" });
  const toggle = (await screen.findByRole("switch", { name: "Let chats check back later" })) as HTMLButtonElement;
  await waitFor(() => assert.equal(toggle.disabled, false));
  const patches = () => calls.filter((call) => call.channel === "schedule:settings" && call.args[0]).map((call) => call.args[0]);
  return { toggle, patches };
}

test("check-backs sit in a While you're away group after Background execution, on by default", async () => {
  const { toggle } = await mount();
  assert.equal(toggle.getAttribute("aria-checked"), "true");
  const background = screen.getByText("Background execution");
  const away = screen.getByText("While you're away");
  const current = screen.getByText("Current tasks");
  assert.ok(background.compareDocumentPosition(away) & Node.DOCUMENT_POSITION_FOLLOWING);
  assert.ok(away.compareDocumentPosition(current) & Node.DOCUMENT_POSITION_FOLLOWING);
  assert.ok(screen.getByText(/Turning this off cancels every pending check-back/u));
  // One group holds both rows: keep awake first, then check-backs.
  const keepAwake = await screen.findByRole("switch", { name: "Keep this computer awake while Aiden works" });
  assert.ok(keepAwake.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING);
  assert.equal(screen.getAllByText("While you're away").length, 1);
});

test("turning check-backs off saves false, and on again saves true", async () => {
  const { toggle, patches } = await mount();
  fireEvent.click(toggle);
  await waitFor(() => assert.equal(toggle.getAttribute("aria-checked"), "false"));
  assert.deepEqual(last(patches()), { chatCheckBacks: false });
  await waitFor(() => assert.equal(toggle.disabled, false));
  fireEvent.click(toggle);
  await waitFor(() => assert.equal(toggle.getAttribute("aria-checked"), "true"));
  assert.deepEqual(last(patches()), { chatCheckBacks: true });
});
