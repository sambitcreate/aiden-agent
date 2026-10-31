import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor, waitForElementToBeRemoved, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { emitBotTestNotification, installBotTestIpc } from "../../main/bots/test-dom";
import { createBotTestQueryClient } from "../../main/bots/test-providers";
import { AppCapabilitiesProvider, DISABLED_APP_CAPABILITIES } from "../../lib/app-capabilities";
import {
  BOT_COMPUTERS_CHANGED_CHANNEL,
  DEFAULT_BOT_COMPUTERS_SETTINGS,
  type BotComputersStatus,
  type BotComputerSetupState,
} from "../../shared/bot-computers";
import { BotComputersSettings } from "./bot-computers-settings";

afterEach(cleanup);
const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

function status(setup: BotComputerSetupState, extra: Partial<BotComputersStatus> = {}): BotComputersStatus {
  return {
    setup,
    settings: { ...DEFAULT_BOT_COMPUTERS_SETTINGS },
    diskUsedBytes: 0,
    computers: [],
    requirements: {
      downloadBytes: 19_772_231_540,
      baseDiskBytes: 50_000_000_000,
      setupFreeBytes: 84_196_731_252,
      memoryPerComputerBytes: 8 * 1024 ** 3,
      baseVersion: "26.6.2",
    },
    ...extra,
  };
}

const READY: BotComputerSetupState = { kind: "ready", baseVersion: "26.6.2", baseBuild: "25G83", updateAvailable: false };

/** Main as the page sees it: a status that Set up, Remove everything and settings change. */
function mount(
  initial: BotComputersStatus,
  options: { botComputers?: boolean; failSettings?: boolean; handlers?: Record<string, (...args: unknown[]) => unknown> } = {},
) {
  let current = initial;
  const calls = installBotTestIpc({
    "botComputers:status": () => current,
    "botComputers:setUp": () => {
      current = { ...current, setup: { kind: "downloading", receivedBytes: 0, totalBytes: current.requirements.downloadBytes } };
      return current;
    },
    "botComputers:cancelSetUp": () => {
      current = { ...current, setup: { kind: "not_set_up" } };
    },
    "botComputers:updateBase": () => current,
    "botComputers:removeEverything": () => {
      current = status({ kind: "not_set_up" });
      return current;
    },
    "botComputers:updateSettings": (patch) => {
      if (options.failSettings) throw new Error("Error invoking remote method 'botComputers:updateSettings': Error: The disk is full.");
      current = { ...current, settings: { ...current.settings, ...(patch as object) } };
      return current.settings;
    },
    ...options.handlers,
  });
  render(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <AppCapabilitiesProvider
        capabilities={{ ...DISABLED_APP_CAPABILITIES, platform: "darwin", computerUse: true, botComputers: options.botComputers ?? true }}
      >
        <BotComputersSettings />
      </AppCapabilitiesProvider>
    </QueryClientProvider>,
  );
  const channels = () => calls.map((call) => call.channel);
  return { calls, channels, push: (next: BotComputersStatus) => {
    current = next;
    emitBotTestNotification(BOT_COMPUTERS_CHANGED_CHANNEL, next);
  } };
}

test("before Set up the page says what is downloaded, from where and how big, and downloads nothing", async () => {
  const { channels } = mount(status({ kind: "not_set_up" }));
  const setUp = await screen.findByRole("button", { name: "Set up" });
  const page = document.body.textContent ?? "";
  assert.match(page, /downloads macOS 26\.6\.2 from Apple \(about 20 GB\)/u);
  assert.match(page, /base computer of about 50 GB/u);
  assert.match(page, /needs about 84 GB free/u);
  assert.match(page, /Nothing is downloaded until you choose Set up\./u);
  assert.match(page, /about 8 GB of memory/u);
  assert.deepEqual(channels(), ["botComputers:status"], "opening the page only reads status");
  fireEvent.click(setUp);
  await flush();
  assert.deepEqual(channels().filter((channel) => channel !== "botComputers:status"), ["botComputers:setUp"]);
});

test("the download shows its percentage and Cancel, which takes focus from Set up and reaches main", async () => {
  const { channels, push } = mount(status({ kind: "not_set_up" }));
  const setUp = await screen.findByRole("button", { name: "Set up" });
  setUp.focus();
  fireEvent.click(setUp);
  await flush();
  const cancel = await screen.findByRole("button", { name: "Cancel" });
  assert.equal(document.activeElement, cancel, "focus moves to the control that replaced Set up");
  act(() => push(status({ kind: "downloading", receivedBytes: 9_886_115_770, totalBytes: 19_772_231_540 })));
  await waitFor(() => assert.equal(screen.getByRole("progressbar", { name: "Downloading macOS" }).getAttribute("aria-valuenow"), "50"));
  assert.match(document.body.textContent ?? "", /Downloading macOS 9\.9 GB of 19\.8 GB/u);
  assert.equal(screen.getByRole("button", { name: "Remove everything" }).hasAttribute("disabled"), true, "Cancel first");
  fireEvent.click(cancel);
  await flush();
  assert.ok(channels().includes("botComputers:cancelSetUp"));
  await screen.findByRole("button", { name: "Set up" });
});

test("a failed setup shows why and offers Try again", async () => {
  mount(status({ kind: "failed", message: "The download stalled. Choose Set up to continue where it stopped.", resumable: true }));
  await screen.findByRole("button", { name: "Try again" });
  assert.match(document.body.textContent ?? "", /The download stalled/u);
});

test("changing a setting saves only that choice, and a refused save shows the old choice again", async () => {
  const { calls } = mount(status(READY));
  fireEvent.click(await screen.findByRole("combobox", { name: "Computers running at once" }));
  fireEvent.click(await screen.findByRole("option", { name: "1 computer" }));
  await flush();
  assert.deepEqual(
    calls.filter((call) => call.channel === "botComputers:updateSettings").map((call) => call.args[0]),
    [{ maxRunning: 1 }],
  );
  assert.match(screen.getByRole("combobox", { name: "Computers running at once" }).textContent ?? "", /1 computer/u);
  cleanup();

  mount(status(READY), { failSettings: true });
  fireEvent.click(await screen.findByRole("combobox", { name: "Stop when idle" }));
  fireEvent.click(await screen.findByRole("option", { name: "30 minutes" }));
  await flush();
  assert.match(screen.getByRole("combobox", { name: "Stop when idle" }).textContent ?? "", /10 minutes/u);
});

test("Remove everything asks first, then empties the page back to Set up", async () => {
  const { channels } = mount(
    status(READY, {
      diskUsedBytes: 61_000_000_000,
      freeDiskBytes: 400_000_000_000,
      computers: [
        { botId: "bot-1", vmName: "aiden-bot-0123456789abcdef", state: "stopped", baseBuild: "25G83", outdated: false, controller: "bot" },
      ],
    }),
  );
  await screen.findByText("61 GB · 400 GB free");
  assert.ok(screen.getByText("The base computer and 1 Bot computer."));
  fireEvent.click(screen.getByRole("button", { name: "Remove everything" }));
  const dialog = await screen.findByRole("alertdialog");
  assert.match(dialog.textContent ?? "", /Files in each Bot's Computer folder stay/u);
  assert.equal(channels().includes("botComputers:removeEverything"), false, "nothing is removed before confirming");
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove everything" }));
  await screen.findByRole("button", { name: "Set up" });
  assert.equal(channels().filter((channel) => channel === "botComputers:removeEverything").length, 1);
});

test("a newer pinned base offers Update base", async () => {
  const { channels } = mount(status({ ...READY, updateAvailable: true }));
  fireEvent.click(await screen.findByRole("button", { name: "Update base" }));
  await flush();
  assert.ok(channels().includes("botComputers:updateBase"));
});

test("a Mac older than macOS 26 says why and offers nothing to set up", async () => {
  mount(status({ kind: "unsupported", reason: "host_os" }));
  await screen.findByRole("group", { name: "Base computer" });
  assert.match(document.body.textContent ?? "", /Bot computers need macOS 26 or later on this Mac\./u);
  assert.equal(screen.queryByRole("button", { name: "Set up" }), null);
  assert.equal(screen.queryByRole("combobox"), null);
});

test("without the Bot computers capability the page asks main for nothing", async () => {
  const { calls } = mount(status({ kind: "not_set_up" }), { botComputers: false });
  await flush();
  assert.ok(screen.getByText("Bot computers need a Mac with Apple silicon."));
  assert.deepEqual(calls, []);
});

const PERMISSIONS: BotComputerSetupState = {
  kind: "building_base",
  step: "permissions",
  permissions: { accessibility: true, screenRecording: false },
};

/** The base's screen is lent but never connects in the DOM. */
const never = () => new Promise<never>(() => undefined);

test("while setup waits for the grants, the page shows the base computer, what is allowed so far, Check again and Skip", async () => {
  let grants = 0;
  const { channels, push } = mount(status(PERMISSIONS), {
    handlers: {
      // The first grant names the base's screen; the stream's own request for a grant is held,
      // so no socket connects in the DOM.
      "botComputers:baseViewerGrant": () =>
        (grants += 1) === 1
          ? {
              hostId: "bot-computers",
              deviceId: "aiden-bot-computers-base",
              grant: { origin: "http://127.0.0.1:52100", token: "a".repeat(43), expiresAt: Date.now() + 60_000 },
            }
          : never(),
      "botComputers:checkPermissions": () => undefined,
      "botComputers:skipPermissions": () => undefined,
    },
  });
  const step = await screen.findByRole("group", { name: "Allow Accessibility and Screen Recording for cua-driver" });
  await waitFor(() => assert.ok(within(step).getByRole("application", { name: /base computer's screen/u })));
  const rows = within(step).getByRole("list", { name: "Permissions in the base computer" });
  assert.deepEqual(
    within(rows)
      .getAllByRole("listitem")
      .map((row) => row.textContent),
    ["AccessibilityAllowed", "Screen RecordingNot yet"],
  );
  assert.equal(screen.queryByRole("progressbar"), null, "no progress bar while setup waits on the person");

  fireEvent.click(within(step).getByRole("button", { name: "Check again" }));
  await flush();
  fireEvent.click(within(step).getByRole("button", { name: "Skip" }));
  await flush();
  assert.deepEqual(
    channels().filter((channel) => channel === "botComputers:checkPermissions" || channel === "botComputers:skipPermissions"),
    ["botComputers:checkPermissions", "botComputers:skipPermissions"],
  );

  // Once both are on and the probe passes, the step goes and the base is ready with element control.
  act(() => push(status({ ...READY, elementControl: true })));
  await waitForElementToBeRemoved(() => screen.queryByRole("group", { name: /Allow Accessibility/u }));
  assert.ok(screen.getByRole("group", { name: "Element control" }).textContent?.includes("On"));
});

test("a base the lent screen can't reach says so and offers Try again", async () => {
  mount(status(PERMISSIONS), {
    handlers: {
      "botComputers:baseViewerGrant": () => {
        throw new Error("Error invoking remote method 'botComputers:baseViewerGrant': Error: The base computer isn't waiting for you.");
      },
    },
  });
  const alert = await screen.findByRole("alert");
  assert.match(alert.textContent ?? "", /The base computer isn't waiting for you\./u);
  assert.ok(screen.getByRole("button", { name: "Try again" }));
});

test("a ready base without element control says why and offers to set it up", async () => {
  const { channels } = mount(
    status({ ...READY, elementControl: false, elementControlNote: "Element control was skipped, so Bots act on the screen only." }),
    {
      handlers: {
        "botComputers:setUpElementControl": () => status({ kind: "building_base", step: "guest_driver" }),
        "botComputers:baseViewerGrant": never,
      },
    },
  );
  const row = await screen.findByRole("group", { name: "Element control" });
  assert.match(row.textContent ?? "", /Element control was skipped, so Bots act on the screen only\./u);
  assert.match(row.textContent ?? "", /get it after a Reset/u);
  fireEvent.click(within(row).getByRole("button", { name: "Set up element control" }));
  await flush();
  assert.deepEqual(
    channels().filter((channel) => channel === "botComputers:setUpElementControl"),
    ["botComputers:setUpElementControl"],
  );
  await waitFor(() => assert.match(document.body.textContent ?? "", /Installing Aiden's helper in the base computer/u));
  assert.equal(screen.queryByRole("group", { name: "Element control" }), null);
});
