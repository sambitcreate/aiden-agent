import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { emitBotTestNotification, installBotTestIpc } from "../../main/bots/test-dom";
import { mountWithBotRouter } from "../../main/bots/test-providers";
import { KEEP_AWAKE_CHANGED_CHANNEL, type KeepAwakeStatus } from "../../shared/keep-awake";
import { ScheduledTasksSettings } from "./scheduled-tasks-settings";

afterEach(cleanup);

const idle: KeepAwakeStatus = {
  supported: true,
  enabled: true,
  holding: false,
  pausedWhileIdle: false,
  counts: {},
};

async function mount(status: KeepAwakeStatus = idle, stored: Record<string, unknown> = {}) {
  let settings = { ...stored };
  const patches: unknown[] = [];
  installBotTestIpc({
    "schedule:settings": (patch: unknown) => {
      if (patch && typeof patch === "object") {
        patches.push(patch);
        const keepAwake = (patch as { keepAwakeWhileWorking?: unknown }).keepAwakeWhileWorking;
        if (typeof keepAwake === "boolean")
          settings = { ...settings, keepAwakeWhileWorking: keepAwake ? undefined : false };
      }
      return {
        enabled: true,
        defaultMode: "llm",
        defaultPermission: "read-only",
        defaultMcpEnabled: false,
        defaultNotify: true,
        defaultTimezone: "UTC",
        keepAwakeWhileWorking: settings.keepAwakeWhileWorking !== false,
      };
    },
    "schedule:keepAwakeStatus": () => status,
    "schedule:list": () => [],
    "mcp:list": () => [],
  });
  await mountWithBotRouter(<ScheduledTasksSettings />, { initialPath: "/settings" });
  return { patches, stored: () => settings };
}

test("While you're away follows Background execution and turning keep-awake off saves false", async () => {
  const page = await mount();
  const groups = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
  assert.deepEqual(groups.slice(0, 2), ["Background execution", "While you're away"]);

  const row = await screen.findByRole("group", {
    name: "Keep this computer awake while Aiden works",
  });
  within(row).getByText(/closing a laptop's lid still puts it to sleep/u);
  await within(row).findByText("Not needed right now");
  const toggle = within(row).getByRole("switch", {
    name: "Keep this computer awake while Aiden works",
  });
  // On by default.
  await waitFor(() => assert.equal(toggle.getAttribute("aria-checked"), "true"));

  fireEvent.click(toggle);
  await waitFor(() => assert.deepEqual(page.patches, [{ keepAwakeWhileWorking: false }]));
  assert.equal(page.stored().keepAwakeWhileWorking, false);
  await waitFor(() => assert.equal(toggle.getAttribute("aria-checked"), "false"));
});

test("the live line follows main's pushes", async () => {
  await mount();
  const row = await screen.findByRole("group", {
    name: "Keep this computer awake while Aiden works",
  });
  await within(row).findByText("Not needed right now");
  act(() => {
    emitBotTestNotification(KEEP_AWAKE_CHANGED_CHANNEL, {
      ...idle,
      holding: true,
      counts: { chat: 1 },
    });
  });
  await within(row).findByText("Keeping awake: 1 chat working");
});

test("a host that can't keep itself awake shows no keep-awake row", async () => {
  await mount({ ...idle, supported: false });
  await screen.findByText("Background execution");
  await waitFor(() =>
    assert.equal(
      screen.queryByRole("group", { name: "Keep this computer awake while Aiden works" }),
      null,
    ),
  );
});
