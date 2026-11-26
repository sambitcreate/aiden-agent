import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { installBotTestIpc } from "../main/bots/test-dom";
import { mountWithBotRouter } from "../main/bots/test-providers";
import { useSettings } from "../lib/queries";
import type { AgentSliderSettings } from "../shared/agent-slider";
import type { GenerationThinkingLevel } from "../shared/generation-thinking";
import type { SettingsSection } from "../shared/settings-section";
import type { AppSettings, Provider } from "../lib/types";
import { AgentModelPopover } from "./agent-model-popover";
import { Toaster } from "./ui";

afterEach(cleanup);

const acme: Provider = {
  id: "acme",
  kind: "openai-compatible" as Provider["kind"],
  label: "Acme Cloud",
  baseUrl: "https://acme.invalid/v1",
  models: ["fast-model", "mid-model", "smart-model", "other-model"],
  needsKey: false,
  hasKey: true,
};
const locked: Provider = {
  id: "locked",
  kind: "openai-compatible" as Provider["kind"],
  label: "Locked Cloud",
  baseUrl: "https://locked.invalid/v1",
  models: ["locked-model"],
  needsKey: true,
  hasKey: false,
};

// Fast, Balanced (home), a stop whose provider isn't signed in, Smart, and an
// empty stop: index 2 and 4 can't run.
const slider: AgentSliderSettings = {
  version: 1,
  homeStopId: "balanced",
  stops: [
    { id: "fast", label: "Fast", providerId: "acme", model: "fast-model" },
    { id: "balanced", label: "Balanced", providerId: "acme", model: "mid-model" },
    { id: "locked", label: "Locked", providerId: "locked", model: "locked-model" },
    { id: "smart", label: "Smart", providerId: "acme", model: "smart-model", thinkingLevel: "high" },
    { id: "spare", label: "Spare" },
  ],
};

function settingsServer(initial: AppSettings) {
  let current = structuredClone(initial);
  const calls = installBotTestIpc({
    "settings:get": () => structuredClone(current),
    "settings:setAgentSlider": (next: unknown) => {
      current = { ...current, agentSlider: next as AgentSliderSettings };
      return structuredClone(current);
    },
    "settings:seedAgentSlider": (next: unknown) => {
      if (!current.agentSlider) current = { ...current, agentSlider: next as AgentSliderSettings };
      return structuredClone(current);
    },
    // Recent models.
    "settings:set": (patch: unknown) => {
      current = { ...current, ...(patch as Partial<AppSettings>) };
      return structuredClone(current);
    },
    "models:info": () => ({}),
  });
  return { calls, current: () => current };
}

interface Pick {
  providerId: string;
  model: string;
  thinkingLevel?: GenerationThinkingLevel;
}

/** A composer that follows its own picks, as chat-pane does. */
function Harness({
  initial,
  picks,
  stops,
  sections,
}: {
  initial: Pick;
  picks: Pick[];
  stops: Pick[];
  sections: SettingsSection[];
}) {
  const settings = useSettings();
  const [selection, setSelection] = React.useState(initial);
  return (
    <>
      <AgentModelPopover
        providers={[acme, locked]}
        providerId={selection.providerId}
        model={selection.model}
        thinkingLevel={selection.thinkingLevel}
        slider={settings.data?.agentSlider}
        settingsLoaded={settings.data !== undefined}
        onChange={(providerId, model) => {
          picks.push({ providerId, model });
          setSelection({ providerId, model });
        }}
        onSelectStop={(providerId, model, thinkingLevel) => {
          const next = { providerId, model, ...(thinkingLevel ? { thinkingLevel } : {}) };
          stops.push(next);
          setSelection(next);
        }}
        onOpenSettings={(section) => sections.push(section)}
      />
      <Toaster />
    </>
  );
}

async function openPopover(
  settings: AppSettings,
  initial: Pick = { providerId: "acme", model: "mid-model" },
) {
  const server = settingsServer(settings);
  const picks: Pick[] = [];
  const stops: Pick[] = [];
  const sections: SettingsSection[] = [];
  await mountWithBotRouter(
    <Harness initial={initial} picks={picks} stops={stops} sections={sections} />,
  );
  await act(async () => {
    await waitFor(() => assert.ok(server.calls.some((call) => call.channel === "settings:get")));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  fireEvent.click(screen.getByRole("button", { name: /Choose a model/u }));
  return { server, picks, stops, sections };
}

function thumb(): HTMLElement {
  return screen.getByRole("slider", { name: "Agent Slider" });
}

function stopTarget(index: number): HTMLElement {
  const target = document.querySelector<HTMLElement>(`[data-agent-slider-stop="${index}"]`);
  assert.ok(target, `a click target for stop ${index}`);
  return target;
}

function modelOption(label: string): HTMLElement {
  const option = screen
    .getAllByRole("option")
    .find((candidate) => candidate.textContent?.includes(label));
  assert.ok(option, `an option for ${label}`);
  return option;
}

test("on a stop the thumb reads the stop, its model and effort; it always has a valid value", async () => {
  await openPopover({ agentSlider: slider });
  const slide = await screen.findByRole("slider", { name: "Agent Slider" });
  assert.equal(slide.getAttribute("aria-valuemin"), "1");
  assert.equal(slide.getAttribute("aria-valuemax"), "5");
  assert.equal(slide.getAttribute("aria-valuenow"), "2");
  assert.equal(slide.getAttribute("aria-valuetext"), "Balanced, Mid Model");
  // The trigger shows the stop's name and still says which model runs.
  const trigger = screen.getByRole("button", { name: /^Selected model:/u });
  assert.match(trigger.getAttribute("aria-label") ?? "", /Mid Model, Balanced on the Agent Slider/u);
  assert.match(trigger.textContent ?? "", /Balanced$/u);
});

test("a chat on no stop is Custom: the thumb rests on the home stop and names the model", async () => {
  await openPopover({ agentSlider: slider }, { providerId: "acme", model: "other-model" });
  const slide = await screen.findByRole("slider", { name: "Agent Slider" });
  assert.equal(slide.getAttribute("aria-valuenow"), "2");
  assert.equal(slide.getAttribute("aria-valuetext"), "Custom: Other Model");
  // The same model at an effort no stop names is Custom too.
  cleanup();
  await openPopover({ agentSlider: slider }, { providerId: "acme", model: "mid-model", thinkingLevel: "low" });
  assert.match((await screen.findByRole("slider")).getAttribute("aria-valuetext") ?? "", /^Custom: Mid Model/u);
});

test("arrow keys, Home and End move only among stops that can run", async () => {
  const { stops } = await openPopover({ agentSlider: slider });
  await screen.findByRole("slider");

  // Right from Balanced skips the signed-out stop and lands on Smart, at its effort.
  fireEvent.keyDown(thumb(), { key: "ArrowRight" });
  assert.deepEqual(stops[stops.length - 1], { providerId: "acme", model: "smart-model", thinkingLevel: "high" });
  assert.equal(thumb().getAttribute("aria-valuenow"), "4");
  assert.equal(thumb().getAttribute("aria-valuetext"), "Smart, Smart Model, High");

  // Nothing that can run lies right of Smart: the empty stop is skipped.
  fireEvent.keyDown(thumb(), { key: "ArrowRight" });
  fireEvent.keyDown(thumb(), { key: "End" });
  assert.equal(stops.length, 1);

  fireEvent.keyDown(thumb(), { key: "Home" });
  assert.deepEqual(stops[stops.length - 1], { providerId: "acme", model: "fast-model" });
  fireEvent.keyDown(thumb(), { key: "ArrowLeft" });
  assert.equal(stops.length, 2);
});

test("in Custom a step starts from the home stop", async () => {
  const { stops } = await openPopover({ agentSlider: slider }, { providerId: "acme", model: "other-model" });
  await screen.findByRole("slider");
  fireEvent.keyDown(thumb(), { key: "ArrowLeft" });
  assert.deepEqual(stops, [{ providerId: "acme", model: "fast-model" }]);
});

test("clicking a stop that can run moves the chat; one that can't asks for a model instead", async () => {
  const { stops, server } = await openPopover({ agentSlider: slider });
  await screen.findByRole("slider");

  fireEvent.click(stopTarget(0));
  assert.deepEqual(stops, [{ providerId: "acme", model: "fast-model" }]);

  fireEvent.click(stopTarget(2));
  assert.equal(stops.length, 1, "an unavailable stop never moves the chat");
  assert.ok(await screen.findByRole("heading", { name: "Choose a model for Locked" }));
  assert.ok(screen.getByText("Sign in to Locked Cloud"));

  // Escape goes back to the slider and saves nothing.
  fireEvent.keyDown(await screen.findByLabelText("Filter chat models"), { key: "Escape" });
  assert.ok(await screen.findByRole("slider"));
  assert.equal(server.calls.filter((call) => call.channel === "settings:setAgentSlider").length, 0);
});

test("choosing a model for an unavailable stop saves it on the stop and moves the chat there", async () => {
  const { stops, picks, server } = await openPopover({ agentSlider: slider });
  await screen.findByRole("slider");
  fireEvent.click(stopTarget(4));
  assert.ok(await screen.findByRole("heading", { name: "Choose a model for Spare" }));
  assert.ok(screen.getByText("Choose a model"));

  fireEvent.click(modelOption("Other Model"));

  await waitFor(() => assert.equal(stops.length, 1));
  assert.deepEqual(stops[0], { providerId: "acme", model: "other-model" });
  assert.equal(picks.length, 0, "a reassign is a stop pick, not a list pick");
  const saved = server.current().agentSlider;
  assert.deepEqual(saved?.stops[4], { id: "spare", label: "Spare", providerId: "acme", model: "other-model" });
  // The other stops are untouched.
  assert.deepEqual(saved?.stops.slice(0, 4), slider.stops.slice(0, 4));
  await waitFor(() => assert.equal(screen.queryByRole("slider"), null));
});

test("each stop that can't run has a keyboard path to choosing its model", async () => {
  const { stops } = await openPopover({ agentSlider: slider });
  await screen.findByRole("slider");
  const fixes = within(screen.getByRole("list", { name: "Stops without a model to run" }));
  assert.deepEqual(
    fixes.getAllByRole("button").map((button) => button.textContent),
    ["Locked · Sign in to Locked Cloud", "Spare · Choose a model"],
  );
  const spare = fixes.getByRole("button", { name: /^Spare/u });
  spare.focus();
  assert.equal(document.activeElement, spare, "the button takes keyboard focus");
  fireEvent.click(spare);
  assert.ok(await screen.findByRole("heading", { name: "Choose a model for Spare" }));
  assert.equal(stops.length, 0, "opening reassign never moves the chat");
});

test("reset returns to the home stop and is off while the chat is already there", async () => {
  const { stops } = await openPopover({ agentSlider: slider });
  await screen.findByRole("slider");
  const reset = screen.getByRole("button", { name: "Reset to Balanced" });
  assert.equal((reset as HTMLButtonElement).disabled, true);

  fireEvent.keyDown(thumb(), { key: "Home" });
  assert.equal((reset as HTMLButtonElement).disabled, false);
  fireEvent.click(reset);
  assert.deepEqual(stops[stops.length - 1], { providerId: "acme", model: "mid-model" });
});

test("typing on the slider opens the model list filtered by that key", async () => {
  await openPopover({ agentSlider: slider });
  await screen.findByRole("slider");
  fireEvent.keyDown(thumb(), { key: "o" });
  const filter = (await screen.findByLabelText("Filter chat models")) as HTMLInputElement;
  assert.equal(filter.value, "o");
  assert.equal(screen.queryByRole("slider"), null);
});

test("Other models… opens the full list, and a model from it changes the model only", async () => {
  const { picks, stops } = await openPopover({ agentSlider: slider });
  fireEvent.click(await screen.findByRole("button", { name: /Other models/u }));
  assert.ok(await screen.findByRole("heading", { name: "Other models" }));
  fireEvent.click(modelOption("Other Model"));
  assert.deepEqual(picks, [{ providerId: "acme", model: "other-model" }]);
  assert.equal(stops.length, 0);
});

test("Back from the list returns to the slider", async () => {
  await openPopover({ agentSlider: slider });
  fireEvent.click(await screen.findByRole("button", { name: /Other models/u }));
  fireEvent.click(await screen.findByRole("button", { name: "Back to slider" }));
  assert.ok(await screen.findByRole("slider"));
});

test("Customize slider… opens the slider's Settings section", async () => {
  const { sections } = await openPopover({ agentSlider: slider });
  fireEvent.click(await screen.findByRole("button", { name: /Customize slider/u }));
  assert.deepEqual(sections, ["agentSlider"]);
});

test("with no saved slider, opening the popover seeds one around the model in use, once", async () => {
  const { server } = await openPopover({}, { providerId: "acme", model: "mid-model" });
  const slide = await screen.findByRole("slider", { name: "Agent Slider" });
  const seeds = server.calls.filter((call) => call.channel === "settings:seedAgentSlider");
  assert.equal(seeds.length, 1);
  // The model in use is the home stop, so the chat sits on it.
  const seeded = server.current().agentSlider!;
  const home = seeded.stops.find((stop) => stop.id === seeded.homeStopId);
  assert.equal(home?.providerId, "acme");
  assert.equal(home?.model, "mid-model");
  assert.equal(slide.getAttribute("aria-valuetext")?.startsWith("Custom"), false);
});

test("a stop list where nothing can run leaves the chat in Custom", async () => {
  const offline: AgentSliderSettings = {
    version: 1,
    homeStopId: "a",
    stops: [
      { id: "a", label: "A", providerId: "locked", model: "locked-model" },
      { id: "b", label: "B" },
      { id: "c", label: "C", providerId: "gone", model: "x" },
    ],
  };
  const { stops } = await openPopover({ agentSlider: offline });
  const slide = await screen.findByRole("slider");
  assert.match(slide.getAttribute("aria-valuetext") ?? "", /^Custom: /u);
  fireEvent.keyDown(slide, { key: "ArrowRight" });
  assert.equal(stops.length, 0);
  fireEvent.click(stopTarget(2));
  assert.ok(await screen.findByRole("heading", { name: "Choose a model for C" }));
  assert.ok(screen.getByText("gone was removed"));
});
