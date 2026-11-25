import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { emitBotTestNotification, installBotTestIpc } from "../../main/bots/test-dom";
import { createBotTestQueryClient } from "../../main/bots/test-providers";
import { AppCapabilitiesProvider, DISABLED_APP_CAPABILITIES } from "../../lib/app-capabilities";
import {
  BOT_COMPUTERS_CHANGED_CHANNEL,
  DEFAULT_BOT_COMPUTERS_SETTINGS,
  type BotComputersStatus,
  type BotComputerSetupState,
  type BotComputerVmStatus,
} from "../../shared/bot-computers";
import { BotComputersSettings } from "./bot-computers-settings";

afterEach(cleanup);
const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

function status(setup: BotComputerSetupState, extra: Partial<BotComputersStatus> = {}): BotComputersStatus {
  return {
    setup,
    settings: { ...DEFAULT_BOT_COMPUTERS_SETTINGS },
    diskUsedBytes: 0,
    vms: [],
    computers: [],
    requirements: {
      downloadBytes: 3_221_225_472,
      baseDiskBytes: 8_000_000_000,
      setupFreeBytes: 24_696_061_952,
      memoryPerComputerBytes: 4 * 1024 ** 3,
      baseVersion: "13",
      maxRunningLimit: 4,
    },
    ...extra,
  };
}

const READY: BotComputerSetupState = {
  kind: "ready",
  baseVersion: "13",
  baseBuild: "20261123-2671",
  updateAvailable: false,
};

/** Main as the page sees it: a status that Set up, Remove everything, dismiss and settings change. */
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
    "botComputers:dismissMigrationNotice": () => {
      const next = { ...current };
      delete next.migrationNotice;
      current = next;
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
  return {
    calls,
    channels,
    push: (next: BotComputersStatus) => {
      current = next;
      emitBotTestNotification(BOT_COMPUTERS_CHANGED_CHANNEL, next);
    },
  };
}

test("before Set up the page says what Debian image is downloaded and how big, and downloads nothing", async () => {
  const { channels } = mount(status({ kind: "not_set_up" }));
  const setUp = await screen.findByRole("button", { name: "Set up" });
  const page = document.body.textContent ?? "";
  assert.match(page, /downloads Debian 13 \(about 3 GB, plus desktop packages\)/u);
  assert.match(page, /base computer of about 8 GB/u);
  assert.match(page, /needs about 25 GB free/u);
  assert.match(page, /Nothing is downloaded until you choose Set up\./u);
  assert.match(page, /about 4 GB of memory/u);
  assert.equal(/Apple|macOS 26/u.test(page), false, "Settings does not mention Apple or macOS 26");
  assert.deepEqual(channels(), ["botComputers:status"], "opening the page only reads status");
  fireEvent.click(setUp);
  await flush();
  assert.deepEqual(
    channels().filter((channel) => channel !== "botComputers:status"),
    ["botComputers:setUp"],
  );
});

test("the download shows its percentage and Cancel, which takes focus from Set up and reaches main", async () => {
  const { channels, push } = mount(status({ kind: "not_set_up" }));
  const setUp = await screen.findByRole("button", { name: "Set up" });
  setUp.focus();
  fireEvent.click(setUp);
  await flush();
  const cancel = await screen.findByRole("button", { name: "Cancel" });
  assert.equal(document.activeElement, cancel, "focus moves to the control that replaced Set up");
  act(() => push(status({ kind: "downloading", receivedBytes: 1_610_612_736, totalBytes: 3_221_225_472 })));
  await waitFor(() =>
    assert.equal(screen.getByRole("progressbar", { name: "Downloading Debian Linux" }).getAttribute("aria-valuenow"), "50"),
  );
  assert.match(document.body.textContent ?? "", /Downloading Debian Linux 1\.6 GB of 3\.2 GB/u);
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

test("the running limit shows the memory cost, offers up to maxRunningLimit, and explains what happens at the limit", async () => {
  mount(status(READY));
  const row = await screen.findByRole("group", { name: "Computers running at once" });
  assert.match(row.textContent ?? "", /about 4 GB of memory/u);
  fireEvent.click(within(row).getByRole("button", { name: "About running limit" }));
  assert.match((await screen.findByRole("tooltip")).textContent ?? "", /used longest ago stops/u);
});

test("changing a setting saves up to 4 computers, and a refused save restores the old choice", async () => {
  const { calls } = mount(status(READY));
  fireEvent.click(await screen.findByRole("combobox", { name: "Computers running at once" }));
  const options = await screen.findAllByRole("option");
  assert.deepEqual(
    options.map((option) => option.textContent),
    ["1 computer", "2 computers", "3 computers", "4 computers"],
  );
  fireEvent.click(screen.getByRole("option", { name: "4 computers" }));
  await flush();
  assert.deepEqual(
    calls.filter((call) => call.channel === "botComputers:updateSettings").map((call) => call.args[0]),
    [{ maxRunning: 4 }],
  );
  assert.match(screen.getByRole("combobox", { name: "Computers running at once" }).textContent ?? "", /4 computers/u);
  cleanup();

  mount(status(READY), { failSettings: true });
  fireEvent.click(await screen.findByRole("combobox", { name: "Stop when idle" }));
  fireEvent.click(await screen.findByRole("option", { name: "30 minutes" }));
  await flush();
  assert.match(screen.getByRole("combobox", { name: "Stop when idle" }).textContent ?? "", /10 minutes/u);
});

test("running-at-once choices are capped by maxRunningLimit from host memory", async () => {
  mount(
    status(READY, {
      requirements: {
        downloadBytes: 3_221_225_472,
        baseDiskBytes: 8_000_000_000,
        setupFreeBytes: 24_696_061_952,
        memoryPerComputerBytes: 4 * 1024 ** 3,
        baseVersion: "13",
        maxRunningLimit: 2,
      },
    }),
  );
  fireEvent.click(await screen.findByRole("combobox", { name: "Computers running at once" }));
  const options = await screen.findAllByRole("option");
  assert.deepEqual(
    options.map((option) => option.textContent),
    ["1 computer", "2 computers"],
  );
});

test("Remove everything asks first with Linux copy, then empties the page back to Set up", async () => {
  const { channels } = mount(
    status(READY, {
      diskUsedBytes: 9_000_000_000,
      freeDiskBytes: 400_000_000_000,
      computers: [
        {
          botId: "bot-1",
          vmName: "aiden-bot-0123456789abcdef",
          computerId: "aiden-bot-0123456789abcdef",
          computerName: "Dedicated computer",
          shared: false,
          state: "stopped",
          baseBuild: "20261123-2671",
          outdated: false,
          controller: "bot",
        },
      ],
    }),
  );
  await screen.findByText("9 GB · 400 GB free");
  assert.ok(screen.getByText("The base computer and 1 Bot computer."));
  fireEvent.click(screen.getByRole("button", { name: "Remove everything" }));
  const dialog = await screen.findByRole("alertdialog");
  assert.match(dialog.textContent ?? "", /download Debian Linux again/u);
  assert.match(dialog.textContent ?? "", /Files in each Bot's Computer folder stay/u);
  assert.equal(channels().includes("botComputers:removeEverything"), false, "nothing is removed before confirming");
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove everything" }));
  await screen.findByRole("button", { name: "Set up" });
  assert.equal(channels().filter((channel) => channel === "botComputers:removeEverything").length, 1);
});

test("a newer pinned base offers Update base and omits macOS element-control controls", async () => {
  const { channels } = mount(status({ ...READY, updateAvailable: true }));
  fireEvent.click(await screen.findByRole("button", { name: "Update base" }));
  await flush();
  assert.ok(channels().includes("botComputers:updateBase"));
  assert.equal(screen.queryByRole("button", { name: "Set up element control" }), null);
});

test("a Mac older than macOS 14 says why and offers nothing to set up", async () => {
  mount(status({ kind: "unsupported", reason: "host_os" }));
  await screen.findByRole("group", { name: "Base computer" });
  assert.match(document.body.textContent ?? "", /Bot computers need macOS 14 or later on this Mac\./u);
  assert.equal(screen.queryByRole("button", { name: "Set up" }), null);
  assert.equal(screen.queryByRole("combobox"), null);
});

test("without the Bot computers capability the page asks main for nothing", async () => {
  const { calls } = mount(status({ kind: "not_set_up" }), { botComputers: false });
  await flush();
  assert.ok(screen.getByText("Bot computers need a Mac with Apple silicon."));
  assert.deepEqual(calls, []);
});

test("first-launch macOS removal notice displays freed GB and dismisses through IPC", async () => {
  const { channels } = mount(
    status({ kind: "not_set_up" }, { migrationNotice: { freedBytes: 58_000_000_000 } }),
  );
  const notice = await screen.findByRole("status");
  assert.equal(
    notice.textContent,
    "Bot computers now run Linux. Your Mac computers were removed and freed 58 GB. Set up to continue.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  await flush();
  assert.ok(channels().includes("botComputers:dismissMigrationNotice"));
  await waitFor(() => assert.equal(screen.queryByRole("status"), null));
});

test("Default for new Bots saves defaultComputerMode and Computers section manages VMs (create, rename, reset, delete)", async () => {
  const created: unknown[] = [];
  const renamed: unknown[] = [];
  const resetIds: unknown[] = [];
  const deleted: unknown[] = [];
  const updatedSettings: unknown[] = [];
  const sharedVm = {
    id: "shared",
    name: "Shared computer",
    kind: "shared" as const,
    vmName: "aiden-vm-shared",
    state: "running" as const,
    baseBuild: "20261123-2671",
    outdated: false,
    assignedBotIds: ["bot-1", "bot-2"],
    activeBotId: "bot-1",
    queuedBotIds: ["bot-2"],
    diskUsedBytes: 5_000_000_000,
    controller: "bot" as const,
  };
  const dedicatedVm = {
    id: "research",
    name: "Research Linux",
    kind: "dedicated" as const,
    vmName: "aiden-vm-research",
    state: "stopped" as const,
    baseBuild: "20261101-1",
    outdated: true,
    assignedBotIds: [],
    queuedBotIds: [],
    diskUsedBytes: 4_000_000_000,
    controller: "bot" as const,
  };
  let currentVms: BotComputerVmStatus[] = [sharedVm, dedicatedVm];
  let currentSettings = { ...DEFAULT_BOT_COMPUTERS_SETTINGS };
  const initial = status(READY, {
    vms: currentVms,
    diskUsedBytes: 9_000_000_000,
  });
  mount(initial, {
    handlers: {
      "botComputers:status": () => ({ ...initial, settings: currentSettings, vms: currentVms }),
      "bots:list": () => [
        { id: "bot-1", name: "Ada" },
        { id: "bot-2", name: "Ben" },
      ],
      "botComputers:updateSettings": (patch) => {
        updatedSettings.push(patch);
        currentSettings = { ...currentSettings, ...(patch as object) };
        return currentSettings;
      },
      "botComputers:createComputer": (name) => {
        created.push(name);
        const createdVm = {
          id: "dev-box",
          name: String(name || "Linux computer"),
          kind: "dedicated" as const,
          vmName: "aiden-vm-dev-box",
          state: "stopped" as const,
          baseBuild: "20261123-2671",
          outdated: false,
          assignedBotIds: [],
          queuedBotIds: [],
          diskUsedBytes: 0,
          controller: "bot" as const,
        };
        currentVms = [...currentVms, createdVm];
        return createdVm;
      },
      "botComputers:renameComputer": (computerId, name) => {
        renamed.push([computerId, name]);
        const next = { ...dedicatedVm, name: String(name) };
        currentVms = currentVms.map((vm) => (vm.id === computerId ? next : vm));
        return next;
      },
      "botComputers:resetComputer": (computerId) => {
        resetIds.push(computerId);
        const current = currentVms.find((vm) => vm.id === computerId) ?? dedicatedVm;
        const next = { ...current, outdated: false, baseBuild: "20261123-2671" };
        currentVms = currentVms.map((vm) => (vm.id === computerId ? next : vm));
        return next;
      },
      "botComputers:deleteComputer": (computerId, opts) => {
        deleted.push([computerId, opts]);
        currentVms = currentVms.filter((vm) => vm.id !== computerId);
      },
    },
  });

  // Shared VM displays kind/running badges, assigned Bots, disk size, and live active/queued line.
  await screen.findByText(/Ada, Ben · 5 GB · In use by Ada · 1 waiting/u);
  assert.ok(screen.getAllByText("Shared computer").length >= 1);
  assert.ok(screen.getByText("Outdated"));

  // Default for new Bots saves defaultComputerMode.
  const defaultSelect = screen.getByRole("combobox", { name: "Default for new Bots" });
  fireEvent.click(defaultSelect);
  fireEvent.click(await screen.findByRole("option", { name: "New computer for each Bot" }));
  await waitFor(() => assert.deepEqual(updatedSettings, [{ defaultComputerMode: "dedicated" }]));

  // New computer dialog calls createComputer.
  fireEvent.click(screen.getByRole("button", { name: "New computer" }));
  const createDialog = await screen.findByRole("dialog");
  fireEvent.change(within(createDialog).getByRole("textbox", { name: "Computer name" }), {
    target: { value: "Dev box" },
  });
  fireEvent.click(within(createDialog).getByRole("button", { name: "Create computer" }));
  await waitFor(() => assert.deepEqual(created, ["Dev box"]));

  // Rename dialog calls renameComputer.
  fireEvent.click(screen.getByRole("button", { name: "Rename Research Linux" }));
  const renameDialog = await screen.findByRole("dialog");
  fireEvent.change(within(renameDialog).getByRole("textbox", { name: "Computer name" }), {
    target: { value: "Lab Linux" },
  });
  fireEvent.click(within(renameDialog).getByRole("button", { name: "Save name" }));
  await waitFor(() => assert.deepEqual(renamed, [["research", "Lab Linux"]]));

  // Reset confirmation calls resetComputer.
  fireEvent.click(await screen.findByRole("button", { name: "Reset Lab Linux" }));
  const resetDialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(resetDialog).getByRole("button", { name: "Reset computer" }));
  await waitFor(() => assert.deepEqual(resetIds, ["research"]));

  // Deleting an assigned VM confirms, shows active holder, passes { force: true }, and restores focus.
  fireEvent.click(screen.getByRole("button", { name: "Delete Shared computer" }));
  const deleteDialog = await screen.findByRole("alertdialog");
  assert.match(deleteDialog.textContent ?? "", /In use by Ada/u);
  assert.match(deleteDialog.textContent ?? "", /2 Bots are currently assigned/u);
  fireEvent.click(within(deleteDialog).getByRole("button", { name: "Delete computer" }));
  await waitFor(() => assert.deepEqual(deleted, [["shared", { force: true }]]));
  await waitFor(() => {
    const active = document.activeElement;
    assert.ok(active && active !== document.body, "focus moves to a remaining VM control or New computer");
  });
});

test("Computers section disables Reset/Delete while starting and reads live status at Delete confirm time", async () => {
  const deleted: unknown[] = [];
  const startingVm: BotComputerVmStatus = {
    id: "booting",
    name: "Booting Linux",
    kind: "dedicated",
    vmName: "aiden-vm-booting",
    state: "starting",
    baseBuild: "20261123-2671",
    outdated: false,
    assignedBotIds: [],
    queuedBotIds: [],
    controller: "bot",
  };
  const idleVm: BotComputerVmStatus = {
    id: "lab",
    name: "Lab Linux",
    kind: "dedicated",
    vmName: "aiden-vm-lab",
    state: "stopped",
    baseBuild: "20261123-2671",
    outdated: false,
    assignedBotIds: [],
    queuedBotIds: [],
    controller: "bot",
  };
  const initial = status(READY, { vms: [startingVm, idleVm] });
  mount(initial, {
    handlers: {
      "bots:list": () => [{ id: "bot-1", name: "Ada" }],
      "botComputers:deleteComputer": (computerId, opts) => {
        deleted.push([computerId, opts]);
      },
    },
  });

  // Reset and Delete are disabled while a VM is starting.
  const resetBooting = await screen.findByRole("button", { name: "Reset Booting Linux" });
  const deleteBooting = screen.getByRole("button", { name: "Delete Booting Linux" });
  assert.equal((resetBooting as HTMLButtonElement).disabled, true);
  assert.equal((deleteBooting as HTMLButtonElement).disabled, true);

  // Open Delete while Lab Linux has 0 Bots assigned, then emit a live status assigning Ada before Confirm.
  fireEvent.click(screen.getByRole("button", { name: "Delete Lab Linux" }));
  const dialog = await screen.findByRole("alertdialog");
  assert.doesNotMatch(dialog.textContent ?? "", /currently assigned/u);

  act(() => {
    emitBotTestNotification(
      BOT_COMPUTERS_CHANGED_CHANNEL,
      status(READY, {
        vms: [startingVm, { ...idleVm, assignedBotIds: ["bot-1"], activeBotId: "bot-1" }],
      }),
    );
  });
  await waitFor(() => {
    assert.match(dialog.textContent ?? "", /In use by Ada/u);
    assert.match(dialog.textContent ?? "", /1 Bot is currently assigned/u);
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete computer" }));
  await waitFor(() => assert.deepEqual(deleted, [["lab", { force: true }]]));
});
