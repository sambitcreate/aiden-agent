import "../../main/bots/test-dom";
import { installBotTestIpc } from "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { QuickChatSettings } from "./quick-chat-settings";

afterEach(() => cleanup());

test("QuickChatSettings defaults to Temporary and pinned mini-modal, and persists Switch toggles", async () => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const calls = installBotTestIpc({
    "settings:get": () => ({}),
    "settings:set": (patch: unknown) => ({
      ...(patch as Record<string, unknown>),
    }),
  });

  try {
    render(
      <QueryClientProvider client={qc}>
        <QuickChatSettings />
      </QueryClientProvider>,
    );

    const modeTrigger = await screen.findByRole("combobox", { name: "Default Quick Chat mode" });
    assert.ok(modeTrigger.textContent?.includes("Temporary"));

    const blurSwitch = screen.getByRole("switch", {
      name: "Keep mini-modal open when clicking outside",
    }) as HTMLButtonElement;
    assert.equal(blurSwitch.getAttribute("aria-checked"), "true");
    await waitFor(() => {
      assert.equal(blurSwitch.disabled, false);
    });

    await act(async () => {
      fireEvent.click(blurSwitch);
    });

    await waitFor(() => {
      const setCall = calls.find((c) => c.channel === "settings:set");
      assert.ok(setCall);
      assert.deepEqual(setCall.args[0], { quickChatKeepOpenOnBlur: false });
    });
    assert.equal(blurSwitch.getAttribute("aria-checked"), "false");
  } finally {
    qc.clear();
  }
});

test("QuickChatSettings reflects stored quickChatDefaultPersistence and quickChatKeepOpenOnBlur values", async () => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  installBotTestIpc({
    "settings:get": () => ({
      quickChatDefaultPersistence: "lastWorkspace",
      quickChatKeepOpenOnBlur: false,
    }),
  });

  try {
    render(
      <QueryClientProvider client={qc}>
        <QuickChatSettings />
      </QueryClientProvider>,
    );

    const modeTrigger = await screen.findByRole("combobox", { name: "Default Quick Chat mode" });
    await waitFor(() => {
      assert.ok(modeTrigger.textContent?.includes("Last used workspace"));
    });
    const blurSwitch = screen.getByRole("switch", {
      name: "Keep mini-modal open when clicking outside",
    });
    assert.equal(blurSwitch.getAttribute("aria-checked"), "false");
  } finally {
    qc.clear();
  }
});
