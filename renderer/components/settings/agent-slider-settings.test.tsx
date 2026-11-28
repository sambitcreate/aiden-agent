import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { installBotTestIpc } from "../../main/bots/test-dom";
import { createBotTestQueryClient } from "../../main/bots/test-providers";
import { AgentSliderSettings } from "./agent-slider-settings";
import { Toaster } from "../ui";
import type { AgentSliderSettings as Slider } from "../../shared/agent-slider";
import { queryKeys } from "../../lib/queries";
import type { AppSettings, Provider } from "../../lib/types";

const SAVE_ERROR = "Aiden couldn’t save the Agent Slider.";

afterEach(cleanup);
beforeEach(() => {
  localStorage.clear();
  // New chats start on Acme's mid model.
  localStorage.setItem("aiden-agent.providerId", "acme");
  localStorage.setItem("aiden-agent.model", "mid-model");
});

const acme = {
  id: "acme",
  kind: "openai",
  label: "Acme Cloud",
  baseUrl: "https://acme.invalid/v1",
  models: ["fast-model", "mid-model", "smart-model"],
  needsKey: false,
  hasKey: true,
  isBuiltin: true,
  modelMetadata: { "smart-model": { thinkingLevels: ["low", "medium", "high"] } },
} as unknown as Provider;
const lab = {
  id: "lab",
  kind: "openai",
  label: "Home Lab",
  baseUrl: "http://127.0.0.1:1234/v1",
  models: ["tiny-local"],
  needsKey: false,
  hasKey: true,
} as unknown as Provider;

const MODEL_INFO: Record<string, Record<string, unknown>> = {
  acme: {
    "fast-model": { name: "Fast Model" },
    "mid-model": { name: "Mid Model" },
    "smart-model": { name: "Smart Model", reasoning: true },
  },
  lab: { "tiny-local": { name: "Tiny Local" } },
};

function threeStops(): Slider {
  return {
    version: 1,
    homeStopId: "mid",
    stops: [
      { id: "fast", label: "Fast", providerId: "acme", model: "fast-model" },
      { id: "mid", label: "Balanced", providerId: "acme", model: "mid-model" },
      {
        id: "smart",
        label: "Smart",
        providerId: "acme",
        model: "smart-model",
        thinkingLevel: "medium",
      },
    ],
  };
}

/** Decides each slider save in turn: true keeps it, false makes main refuse it. */
type SettleSave = (index: number) => boolean | Promise<boolean>;

function mount(settings: Partial<AppSettings>, settleSave?: SettleSave) {
  let current = structuredClone(settings) as AppSettings;
  const saves: Slider[] = [];
  const seeds: Slider[] = [];
  const calls = installBotTestIpc({
    "settings:get": () => structuredClone(current),
    "settings:setAgentSlider": async (next: unknown) => {
      const index = saves.length;
      saves.push(structuredClone(next as Slider));
      if (settleSave && !(await settleSave(index))) throw new Error("The disk is full.");
      const { agentSliderUnreadable: _cleared, ...rest } = current;
      current = { ...rest, agentSlider: next as Slider };
      return structuredClone(current);
    },
    "settings:seedAgentSlider": (next: unknown) => {
      seeds.push(structuredClone(next as Slider));
      if (!current.agentSlider) current = { ...current, agentSlider: next as Slider };
      return structuredClone(current);
    },
    "settings:set": (patch: unknown) => {
      current = { ...current, ...(patch as Partial<AppSettings>) };
      return structuredClone(current);
    },
    "providers:list": () => [acme, lab],
    "models:info": (providerId: unknown) => MODEL_INFO[providerId as string] ?? {},
  });
  const queryClient = createBotTestQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <AgentSliderSettings />
      <Toaster />
    </QueryClientProvider>,
  );
  return {
    calls,
    saves,
    seeds,
    queryClient,
    lastSaved: () => saves[saves.length - 1],
    persisted: () => current,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const isHome = (label: string) =>
  screen.getByRole("radio", { name: `Home stop: ${label}` }).getAttribute("aria-checked") ===
  "true";

async function stopNames(): Promise<string[]> {
  const inputs = await screen.findAllByRole("textbox", { name: /^Name of stop/u });
  return inputs.map((input) => (input as HTMLInputElement).value);
}

test("each stop is a row with its name, model and effort, and the preview rests on home", async () => {
  mount({ agentSlider: threeStops() });
  assert.deepEqual(await stopNames(), ["Fast", "Balanced", "Smart"]);
  await screen.findByRole("button", { name: "Model for Smart: Smart Model. Choose a model." });
  const preview = screen.getByRole("slider", { name: "Agent Slider" });
  assert.match(preview.getAttribute("aria-valuetext") ?? "", /^Balanced, Mid Model/u);
  assert.equal(
    screen.getByRole("radio", { name: "Home stop: Balanced" }).getAttribute("aria-checked"),
    "true",
  );
});

test("at 3 stops Remove does nothing and says why", async () => {
  const { saves } = mount({ agentSlider: threeStops() });
  const remove = await screen.findByRole("button", { name: "Remove Fast" });
  assert.equal(remove.getAttribute("aria-disabled"), "true");
  const reason = document.getElementById(remove.getAttribute("aria-describedby") ?? "");
  assert.equal(reason?.textContent, "The slider needs at least 3 stops. Add one first.");
  fireEvent.click(remove);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.equal(saves.length, 0);
  assert.deepEqual(await stopNames(), ["Fast", "Balanced", "Smart"]);
});

test("Add stop puts a uniquely named Choose a model stop at the end, up to 7, then says why not", async () => {
  const slider = threeStops();
  slider.stops.push(
    { id: "s4", label: "Stop 5" },
    { id: "s5", label: "Extra" },
    { id: "s6", label: "More" },
  );
  const { saves } = mount({ agentSlider: slider });
  fireEvent.click(await screen.findByRole("button", { name: "Add stop" }));
  await waitFor(() => assert.equal(saves.length, 1));
  const added = saves[0]!.stops[6]!;
  // "Stop 7" is the seventh stop's name; nothing else is called that.
  assert.equal(added.label, "Stop 7");
  assert.equal(added.model, undefined);
  await screen.findByRole("button", { name: "Choose a model for Stop 7" });

  const addButton = screen.getByRole("button", { name: "Add stop" });
  assert.equal(addButton.getAttribute("aria-disabled"), "true");
  const reason = document.getElementById(addButton.getAttribute("aria-describedby") ?? "");
  assert.equal(reason?.textContent, "The slider holds up to 7 stops.");
  fireEvent.click(addButton);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.equal(saves.length, 1);
});

test("removing a stop above 3 saves without it, and a removed home moves to the middle", async () => {
  const slider = threeStops();
  slider.stops.push({ id: "spare", label: "Spare" });
  const { lastSaved } = mount({ agentSlider: slider });
  fireEvent.click(await screen.findByRole("button", { name: "Remove Balanced" }));
  await waitFor(() =>
    assert.deepEqual(
      lastSaved()?.stops.map((stop) => stop.label),
      ["Fast", "Smart", "Spare"],
    ),
  );
  assert.equal(lastSaved()?.homeStopId, "smart");
});

test("the move buttons reorder by keyboard, keep focus and announce the new place", async () => {
  const { lastSaved } = mount({ agentSlider: threeStops() });
  const down = await screen.findByRole("button", { name: "Move Fast down" });
  assert.equal(
    screen.getByRole("button", { name: "Move Fast up" }).getAttribute("aria-disabled"),
    "true",
  );
  down.focus();
  fireEvent.click(down);
  await waitFor(() =>
    assert.deepEqual(
      lastSaved()?.stops.map((stop) => stop.id),
      ["mid", "fast", "smart"],
    ),
  );
  assert.deepEqual(await stopNames(), ["Balanced", "Fast", "Smart"]);
  await waitFor(() =>
    assert.equal(document.activeElement, screen.getByRole("button", { name: "Move Fast down" })),
  );
  assert.ok(screen.getByText("Moved Fast to position 2 of 3"));
});

test("a name saves after a pause; an invalid one shows why and is never saved", async () => {
  const { saves } = mount({ agentSlider: threeStops() });
  const [fast] = await screen.findAllByRole("textbox", { name: /^Name of stop/u });
  fireEvent.change(fast!, { target: { value: "Quick" } });
  assert.equal(saves.length, 0, "typing waits for a pause");
  await waitFor(() => assert.equal(saves.length, 1), { timeout: 2_000 });
  assert.equal(saves[0]!.stops[0]!.label, "Quick");

  fireEvent.change(fast!, { target: { value: "   " } });
  assert.equal(fast!.getAttribute("aria-invalid"), "true");
  const error = document.getElementById(fast!.getAttribute("aria-describedby") ?? "");
  assert.equal(error?.textContent, "Give this stop a name.");
  fireEvent.change(fast!, { target: { value: "x".repeat(25) } });
  assert.equal(
    document.getElementById(fast!.getAttribute("aria-describedby") ?? "")?.textContent,
    "Use 24 characters or fewer.",
  );
  fireEvent.blur(fast!);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 700)));
  assert.equal(saves.length, 1);
  assert.equal(fast!.getAttribute("aria-invalid"), "true", "the bad name stays for fixing");
});

test("choosing a home stop saves it, and Undo in the toast puts the old home back", async () => {
  const { saves, lastSaved } = mount({ agentSlider: threeStops() });
  fireEvent.click(await screen.findByRole("radio", { name: "Home stop: Smart" }));
  await waitFor(() => assert.equal(lastSaved()?.homeStopId, "smart"));
  const toastText = await screen.findByText("Smart is now the home stop");
  const toastElement = toastText.closest("[data-sonner-toast]") as HTMLElement;
  fireEvent.click(within(toastElement).getByRole("button", { name: "Undo" }));
  await waitFor(() => assert.equal(saves.length, 2));
  assert.deepEqual(lastSaved(), threeStops());
  assert.equal(
    screen.getByRole("radio", { name: "Home stop: Balanced" }).getAttribute("aria-checked"),
    "true",
  );
});

test("Undo after the slider changed elsewhere saves nothing and says so", async () => {
  const { saves, queryClient } = mount({ agentSlider: threeStops() });
  fireEvent.click(await screen.findByRole("radio", { name: "Home stop: Smart" }));
  const toastText = await screen.findByText("Smart is now the home stop");
  const undo = within(toastText.closest("[data-sonner-toast]") as HTMLElement).getByRole("button", {
    name: "Undo",
  });
  // Another window (or the composer's reassign) saves a different slider.
  const elsewhere = { ...threeStops(), homeStopId: "fast" };
  act(() => {
    queryClient.setQueryData<AppSettings>(queryKeys.settings, (settings) =>
      settings ? { ...settings, agentSlider: elsewhere } : settings,
    );
  });
  fireEvent.click(undo);
  assert.ok(await screen.findByText("Can’t undo — the slider changed since"));
  assert.equal(saves.length, 1);
  assert.equal(
    screen.getByRole("radio", { name: "Home stop: Fast" }).getAttribute("aria-checked"),
    "true",
  );
});

test("the effort select lists only the model's levels and is absent for a model without them", async () => {
  const { lastSaved } = mount({ agentSlider: threeStops() });
  const effort = await screen.findByRole("combobox", { name: "Effort for Smart" });
  assert.equal(screen.queryByRole("combobox", { name: "Effort for Fast" }), null);
  assert.equal(screen.queryByRole("combobox", { name: "Effort for Balanced" }), null);
  fireEvent.click(effort);
  const options = (await screen.findAllByRole("option")).map((option) => option.textContent);
  assert.deepEqual(options, ["Low", "Medium", "High"]);
  fireEvent.click(screen.getByRole("option", { name: "High" }));
  await waitFor(() => assert.equal(lastSaved()?.stops[2]?.thinkingLevel, "high"));
});

test("a model chosen for an empty stop is saved on that stop", async () => {
  const slider = threeStops();
  slider.stops.push({ id: "spare", label: "Spare" });
  const { lastSaved } = mount({ agentSlider: slider });
  fireEvent.click(await screen.findByRole("button", { name: "Choose a model for Spare" }));
  fireEvent.click(await screen.findByRole("option", { name: /Smart Model/u }));
  await waitFor(() =>
    assert.deepEqual(lastSaved()?.stops[3], {
      id: "spare",
      label: "Spare",
      providerId: "acme",
      model: "smart-model",
      thinkingLevel: "medium",
    }),
  );
});

test("a stop that can't run says why", async () => {
  const slider = threeStops();
  slider.stops[0] = { id: "fast", label: "Fast", providerId: "acme", model: "retired-model" };
  mount({ agentSlider: slider });
  const trigger = await screen.findByRole("button", { name: /^Model for Fast/u });
  const reason = document.getElementById(trigger.getAttribute("aria-describedby") ?? "");
  assert.equal(reason?.textContent, "Model not found");
});

async function openTemplates() {
  const trigger = await screen.findByRole("button", { name: "Templates" });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
}

test("the Effort ladder template replaces the slider with one stop per level, home in the middle", async () => {
  const { lastSaved } = mount({ agentSlider: threeStops() });
  // The home stop's model has no levels, so the ladder uses the next model that has three.
  await screen.findByRole("combobox", { name: "Effort for Smart" });
  await openTemplates();
  fireEvent.click(await screen.findByRole("menuitem", { name: /Effort ladder/u }));
  await waitFor(() => assert.equal(lastSaved()?.stops.length, 3));
  const saved = lastSaved()!;
  assert.deepEqual(
    saved.stops.map((stop) => [stop.providerId, stop.model, stop.thinkingLevel]),
    [
      ["acme", "smart-model", "low"],
      ["acme", "smart-model", "medium"],
      ["acme", "smart-model", "high"],
    ],
  );
  assert.equal(saved.homeStopId, saved.stops[1]!.id);
  assert.ok(await screen.findByText("Applied the Effort ladder"));
});

test("Local to cloud puts the first local model, an empty Balanced and the new-chat model in place", async () => {
  const { lastSaved, saves } = mount({ agentSlider: threeStops() });
  await screen.findByRole("combobox", { name: "Effort for Smart" });
  await openTemplates();
  fireEvent.click(await screen.findByRole("menuitem", { name: /Local to cloud/u }));
  await waitFor(() => assert.equal(saves.length, 1));
  const saved = lastSaved()!;
  assert.deepEqual(
    saved.stops.map(({ id: _id, ...stop }) => stop),
    [
      { label: "Local", providerId: "lab", model: "tiny-local" },
      { label: "Balanced" },
      { label: "Cloud", providerId: "acme", model: "mid-model" },
    ],
  );
  assert.equal(saved.homeStopId, saved.stops[1]!.id);
  // A template is one action: Undo brings the whole old slider back.
  const toastText = await screen.findByText("Applied Local to cloud");
  fireEvent.click(
    within(toastText.closest("[data-sonner-toast]") as HTMLElement).getByRole("button", {
      name: "Undo",
    }),
  );
  await waitFor(() => assert.deepEqual(lastSaved(), threeStops()));
});

test("with no slider saved, Set up builds one around the new-chat model", async () => {
  const { seeds } = mount({});
  const setUp = await screen.findByRole("button", { name: "Set up the Agent Slider" });
  // Disabled, with its reason, until the models have loaded.
  await waitFor(() => assert.equal(setUp.getAttribute("aria-disabled"), null));
  fireEvent.click(setUp);
  await waitFor(() => assert.equal(seeds.length, 1));
  const home = seeds[0]!.stops.find((stop) => stop.id === seeds[0]!.homeStopId);
  assert.equal(home?.providerId, "acme");
  assert.equal(home?.model, "mid-model");
  assert.ok(await screen.findByRole("slider", { name: "Agent Slider" }));
});

test("an unreadable slider is explained and replaced only after confirming", async () => {
  const { saves } = mount({ agentSliderUnreadable: true });
  assert.ok(await screen.findByText(/Your config\.json Agent Slider can’t be read/u));
  fireEvent.click(screen.getByRole("button", { name: "Replace" }));
  const dialog = await screen.findByRole("alertdialog");
  assert.equal(saves.length, 0, "nothing is written before confirming");
  fireEvent.click(within(dialog).getByRole("button", { name: "Replace" }));
  await waitFor(() => assert.equal(saves.length, 1));
  const home = saves[0]!.stops.find((stop) => stop.id === saves[0]!.homeStopId);
  assert.equal(home?.model, "mid-model");
  assert.ok(await screen.findByRole("slider", { name: "Agent Slider" }));
});

test("an older save that fails while a newer one is queued neither reports nor undoes the newer edit", async () => {
  const first = deferred<boolean>();
  const { saves, persisted } = mount({ agentSlider: threeStops() }, (index) =>
    index === 0 ? first.promise : true,
  );
  fireEvent.click(await screen.findByRole("radio", { name: "Home stop: Smart" }));
  await waitFor(() => assert.equal(saves.length, 1));
  fireEvent.click(screen.getByRole("radio", { name: "Home stop: Fast" }));
  await act(async () => {
    first.resolve(false);
  });
  await waitFor(() => assert.equal(saves.length, 2));
  await waitFor(() => assert.equal(persisted().agentSlider?.homeStopId, "fast"));
  // Let any refetch the failure might have started land before looking.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  assert.ok(isHome("Fast"), "the newer edit stays on screen");
  assert.equal(screen.queryByText(SAVE_ERROR), null, "a superseded failure isn't reported");
});

test("when the newest save fails, the editor reports it and shows what main kept", async () => {
  const first = deferred<boolean>();
  const { saves, persisted } = mount({ agentSlider: threeStops() }, (index) =>
    index === 0 ? first.promise : false,
  );
  fireEvent.click(await screen.findByRole("radio", { name: "Home stop: Smart" }));
  await waitFor(() => assert.equal(saves.length, 1));
  fireEvent.click(screen.getByRole("radio", { name: "Home stop: Fast" }));
  await waitFor(() => assert.ok(isHome("Fast"), "the edit shows before main answers"));
  await act(async () => {
    first.resolve(true);
  });
  await screen.findByText(SAVE_ERROR);
  assert.equal(persisted().agentSlider?.homeStopId, "smart");
  await waitFor(() => assert.ok(isHome("Smart"), "the editor settles on the slider main kept"));
});
