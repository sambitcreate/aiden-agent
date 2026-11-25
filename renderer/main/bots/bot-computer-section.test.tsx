import { emitBotTestNotification, installBotTestIpc } from "./test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { AppCapabilitiesProvider, DISABLED_APP_CAPABILITIES } from "../../lib/app-capabilities";
import {
  BOT_COMPUTERS_CHANGED_CHANNEL,
  DEFAULT_BOT_COMPUTERS_SETTINGS,
  type BotComputersStatus,
  type BotComputerSetupState,
  type BotComputerStatus,
} from "../../shared/bot-computers";
import { BotComputerSection } from "./bot-computer-section";
import { mountWithBotRouter } from "./test-providers";

afterEach(cleanup);

const bot = { id: "bot-1", name: "Ada" };
const READY: BotComputerSetupState = { kind: "ready", baseVersion: "26.6.2", baseBuild: "25G83", updateAvailable: false };

function computer(extra: Partial<BotComputerStatus> = {}): BotComputerStatus {
  return {
    botId: bot.id,
    vmName: "aiden-bot-0123456789abcdef",
    computerId: "aiden-bot-0123456789abcdef",
    computerName: "Ada's computer",
    shared: false,
    state: "stopped",
    baseBuild: "25G83",
    outdated: false,
    controller: "bot",
    ...extra,
  };
}

function status(setup: BotComputerSetupState, computers: BotComputerStatus[] = []): BotComputersStatus {
  return {
    setup,
    settings: { ...DEFAULT_BOT_COMPUTERS_SETTINGS },
    diskUsedBytes: 0,
    vms: [],
    computers,
    requirements: {
      downloadBytes: 3_221_225_472,
      baseDiskBytes: 8_000_000_000,
      setupFreeBytes: 24_696_061_952,
      memoryPerComputerBytes: 4 * 1024 ** 3,
      baseVersion: "13",
      maxRunningLimit: 4,
    },
  };
}

/** Main's side for one Bot: give makes a computer, reset makes a fresh one, remove deletes it. */
function botComputersIpc(initial: BotComputersStatus) {
  let current = initial;
  let made = 0;
  const calls = installBotTestIpc({
    "botComputers:status": () => current,
    "botComputers:give": (botId) => {
      made += 1;
      const next = computer({ botId: String(botId) });
      current = { ...current, computers: [...current.computers, next] };
      return next;
    },
    "botComputers:reset": (botId) => {
      made += 1;
      const next = computer({ botId: String(botId), baseBuild: "25G90" });
      current = { ...current, computers: [...current.computers.filter((entry) => entry.botId !== botId), next] };
      return next;
    },
    "botComputers:remove": (botId) => {
      current = { ...current, computers: current.computers.filter((entry) => entry.botId !== botId) };
    },
    "botComputers:stop": () => undefined,
  });
  const sent = (channel: string) => calls.filter((call) => call.channel === channel).map((call) => call.args);
  return { calls, sent, made: () => made, push: (next: BotComputersStatus) => {
    current = next;
    emitBotTestNotification(BOT_COMPUTERS_CHANGED_CHANNEL, next);
  } };
}

async function mount(botComputers = true) {
  return mountWithBotRouter(
    <AppCapabilitiesProvider capabilities={{ ...DISABLED_APP_CAPABILITIES, platform: "darwin", bots: true, botComputers }}>
      <BotComputerSection bot={bot} />
    </AppCapabilitiesProvider>,
    { initialPath: "/bots/bot-1" },
  );
}

test("with a ready base, Give makes the Bot a computer and the section shows its state", async () => {
  const ipc = botComputersIpc(status(READY));
  await mount();
  fireEvent.click(await screen.findByRole("button", { name: "Give a computer" }));
  await screen.findByText("Ada's computer is off. It starts when Ada needs it.");
  assert.deepEqual(ipc.sent("botComputers:give"), [[bot.id]]);
  assert.equal(screen.queryByRole("button", { name: "Give a computer" }), null);
  assert.ok(screen.getByRole("button", { name: "Reset" }));
  assert.ok(screen.getByRole("button", { name: "Remove" }));
});

test("a running computer can be stopped, and a waiting one says it is waiting for another Bot's", async () => {
  const ipc = botComputersIpc(status(READY, [computer({ state: "running", activity: "Opening Safari" })]));
  await mount();
  await screen.findByText("Ada's computer is running.");
  assert.ok(screen.getByText("Opening Safari"));
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  await waitFor(() => assert.deepEqual(ipc.sent("botComputers:stop"), [[bot.id]]));
  ipc.push(status(READY, [computer({ state: "waiting_for_slot" })]));
  await screen.findByText("Waiting for another Bot's computer");
});

test("Reset and Remove each ask first, and only the confirmed one reaches main", async () => {
  const ipc = botComputersIpc(status({ ...READY, baseBuild: "25G90", updateAvailable: false }, [computer({ outdated: true })]));
  await mount();
  await screen.findByText(/Made from an older base/u);

  fireEvent.click(screen.getByRole("button", { name: "Reset" }));
  let dialog = await screen.findByRole("alertdialog");
  assert.match(dialog.textContent ?? "", /Files in Ada's Computer folder stay/u);
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.equal(screen.queryByRole("alertdialog"), null));
  assert.deepEqual(ipc.sent("botComputers:reset"), []);

  fireEvent.click(screen.getByRole("button", { name: "Reset" }));
  dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Reset computer" }));
  await waitFor(() => assert.deepEqual(ipc.sent("botComputers:reset"), [[bot.id, { force: true }]]));
  // The fresh copy is made from the current base.
  await waitFor(() => assert.equal(screen.queryByText(/Made from an older base/u), null));

  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove computer" }));
  await waitFor(() => assert.deepEqual(ipc.sent("botComputers:remove"), [[bot.id]]));
  await screen.findByRole("button", { name: "Give a computer" });
});

test("before Bot computers are set up, the section sends the person to Settings", async () => {
  botComputersIpc(status({ kind: "not_set_up" }));
  const { router } = await mount();
  fireEvent.click(await screen.findByRole("button", { name: "Open Settings" }));
  await waitFor(() => assert.equal(router.state.location.pathname, "/settings"));
  assert.equal((router.state.location.search as { section?: string }).section, "botComputers");
});

test("without the Bot computers capability there is no Computer section and no IPC", async () => {
  const ipc = botComputersIpc(status(READY));
  await mount(false);
  assert.equal(screen.queryByText("Computer"), null);
  assert.deepEqual(ipc.calls.filter((call) => call.channel.startsWith("botComputers:")), []);
});

test("Linux computer picker switches between Shared computer, existing VMs, and + New computer, and shows queue status", async () => {
  const assigned: unknown[] = [];
  const sharedVm = {
    id: "shared",
    name: "Shared computer",
    kind: "shared" as const,
    vmName: "aiden-vm-shared",
    state: "running" as const,
    baseBuild: "25G83",
    outdated: false,
    assignedBotIds: [bot.id, "bot-2"],
    activeBotId: "bot-2",
    queuedBotIds: [bot.id],
    controller: "bot" as const,
  };
  const researchVm = {
    id: "research",
    name: "Research Linux",
    kind: "dedicated" as const,
    vmName: "aiden-vm-research",
    state: "stopped" as const,
    baseBuild: "25G83",
    outdated: false,
    assignedBotIds: [],
    queuedBotIds: [],
    controller: "bot" as const,
  };
  let current: BotComputersStatus = {
    ...status(READY, [
      computer({
        vmName: "aiden-vm-shared",
        computerId: "shared",
        computerName: "Shared computer",
        shared: true,
        state: "running",
        activeBotId: "bot-2",
        queuePosition: 1,
      }),
    ]),
    vms: [sharedVm, researchVm],
  };
  installBotTestIpc({
    "bots:list": () => [
      { id: bot.id, name: "Ada" },
      { id: "bot-2", name: "Ben" },
    ],
    "botComputers:status": () => current,
    "botComputers:assignComputer": (botId, target) => {
      assigned.push([botId, target]);
      const next =
        (target as { kind: string }).kind === "new"
          ? computer({ vmName: "aiden-vm-new-1", computerId: "new-1", computerName: "Ada's Linux", shared: false })
          : computer({ vmName: "aiden-vm-research", computerId: "research", computerName: "Research Linux", shared: false });
      current = { ...current, computers: [next] };
      return next;
    },
  });
  await mount();

  await screen.findByText(/Waiting for Ben on Shared computer \(queue #1\)/u);

  const picker = screen.getByRole("combobox", { name: "Linux computer" });
  fireEvent.click(picker);
  fireEvent.click(await screen.findByRole("option", { name: "Research Linux" }));
  await waitFor(() => assert.deepEqual(assigned[0], [bot.id, { kind: "existing", computerId: "research" }]));

  fireEvent.click(screen.getByRole("combobox", { name: "Linux computer" }));
  fireEvent.click(await screen.findByRole("option", { name: "+ New computer" }));
  await waitFor(() => assert.deepEqual(assigned[1], [bot.id, { kind: "new" }]));
});

test("joining a VM already used by another Bot and stopping an active shared VM both ask for confirmation first", async () => {
  const assigned: unknown[] = [];
  const stopped: unknown[] = [];
  const sharedVm = {
    id: "shared",
    name: "Shared computer",
    kind: "shared" as const,
    vmName: "aiden-vm-shared",
    state: "running" as const,
    baseBuild: "25G83",
    outdated: false,
    assignedBotIds: [bot.id, "bot-2"],
    activeBotId: "bot-2",
    queuedBotIds: [],
    controller: "bot" as const,
  };
  const bensVm = {
    id: "vm-ben",
    name: "Ben's Lab",
    kind: "dedicated" as const,
    vmName: "aiden-vm-ben",
    state: "stopped" as const,
    baseBuild: "25G83",
    outdated: false,
    assignedBotIds: ["bot-2"],
    queuedBotIds: [],
    controller: "bot" as const,
  };
  const current: BotComputersStatus = {
    ...status(READY, [
      computer({
        vmName: "aiden-vm-shared",
        computerId: "shared",
        computerName: "Shared computer",
        shared: true,
        state: "running",
        activeBotId: "bot-2",
      }),
    ]),
    vms: [sharedVm, bensVm],
  };
  installBotTestIpc({
    "bots:list": () => [
      { id: bot.id, name: "Ada" },
      { id: "bot-2", name: "Ben" },
    ],
    "botComputers:status": () => current,
    "botComputers:assignComputer": (botId, target) => {
      assigned.push([botId, target]);
      return computer({ vmName: "aiden-vm-ben", computerId: "vm-ben", computerName: "Ben's Lab", shared: false });
    },
    "botComputers:stop": (botId) => {
      stopped.push(botId);
    },
  });
  await mount();
  await screen.findByText(/Ben is currently using Shared computer/u);

  // Stop on an active shared VM warns before stopping.
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  const stopDialog = await screen.findByRole("alertdialog");
  assert.match(stopDialog.textContent ?? "", /Ben is currently using Shared computer/u);
  assert.deepEqual(stopped, []);
  fireEvent.click(within(stopDialog).getByRole("button", { name: "Stop computer" }));
  await waitFor(() => assert.deepEqual(stopped, [bot.id]));

  // Switching onto another Bot's dedicated VM confirms before assigning.
  fireEvent.click(screen.getByRole("combobox", { name: "Linux computer" }));
  fireEvent.click(await screen.findByRole("option", { name: "Ben's Lab" }));
  const assignDialog = await screen.findByRole("alertdialog");
  assert.match(assignDialog.textContent ?? "", /already used by Ben/u);
  assert.match(assignDialog.textContent ?? "", /share one Linux desktop, user \(aiden-bot\), and Chromium sign-ins/u);
  assert.deepEqual(assigned, []);
  fireEvent.click(within(assignDialog).getByRole("button", { name: "Switch computer" }));
  await waitFor(() => assert.deepEqual(assigned, [[bot.id, { kind: "existing", computerId: "vm-ben" }]]));
});

test("sole-assigned pool VM Remove discloses workspace deletion, confirmed Reset passes force: true, and 1 co-tenant Stop uses singular verb", async () => {
  const resets: unknown[] = [];
  const poolVm = {
    id: "vm-solo",
    name: "Solo Linux",
    kind: "dedicated" as const,
    vmName: "aiden-vm-solo",
    state: "running" as const,
    baseBuild: "25G83",
    outdated: false,
    assignedBotIds: [bot.id],
    queuedBotIds: [],
    controller: "bot" as const,
  };
  let current: BotComputersStatus = {
    ...status(READY, [
      computer({
        vmName: "aiden-vm-solo",
        computerId: "vm-solo",
        computerName: "Solo Linux",
        shared: false,
        state: "running",
      }),
    ]),
    vms: [poolVm],
  };
  installBotTestIpc({
    "bots:list": () => [
      { id: bot.id, name: "Ada" },
      { id: "bot-2", name: "Ben" },
    ],
    "botComputers:status": () => current,
    "botComputers:reset": (botId, opts) => {
      resets.push([botId, opts]);
      return current.computers[0]!;
    },
  });
  await mount();

  // Sole-assigned pool vm-* Remove dialog discloses workspace deletion (~/Shared and ~/bots).
  fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
  const removeDialog = await screen.findByRole("alertdialog");
  assert.match(removeDialog.textContent ?? "", /deletes this virtual machine and its mounted workspace folder \(~\/Shared and ~\/bots\)/u);
  fireEvent.click(within(removeDialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.equal(screen.queryByRole("alertdialog"), null));

  // Confirmed Reset passes { force: true }.
  fireEvent.click(screen.getByRole("button", { name: "Reset" }));
  const resetDialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(resetDialog).getByRole("button", { name: "Reset computer" }));
  await waitFor(() => assert.deepEqual(resets, [[bot.id, { force: true }]]));

  // Stop dialog with 1 idle co-tenant uses singular "Ben also uses".
  const sharedVm = {
    id: "shared",
    name: "Shared computer",
    kind: "shared" as const,
    vmName: "aiden-vm-shared",
    state: "running" as const,
    baseBuild: "25G83",
    outdated: false,
    assignedBotIds: [bot.id, "bot-2"],
    queuedBotIds: [],
    controller: "bot" as const,
  };
  current = {
    ...status(READY, [
      computer({
        vmName: "aiden-vm-shared",
        computerId: "shared",
        computerName: "Shared computer",
        shared: true,
        state: "running",
      }),
    ]),
    vms: [sharedVm],
  };
  emitBotTestNotification(BOT_COMPUTERS_CHANGED_CHANNEL, current);
  await screen.findByText(/Bots on Shared computer share one Linux desktop/u);
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  const stopDialog = await screen.findByRole("alertdialog");
  assert.match(stopDialog.textContent ?? "", /Ben also uses Shared computer\./u);
});
