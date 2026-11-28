import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LiveScreenSourcePicker } from "./assistant-live";
import type { LiveDisplaySourceSummary } from "../../shared/assistant-live";

afterEach(cleanup);

const sources: LiveDisplaySourceSummary[] = [
  {
    id: "screen:0:0",
    name: "Entire screen",
    kind: "screen",
    thumbnail: "data:image/png;base64,AAAA",
  },
  { id: "window:9:0", name: "Editor", kind: "window", thumbnail: "" },
];

function mount(choices: readonly LiveDisplaySourceSummary[] | null) {
  const picks: Array<string | null> = [];
  render(
    <LiveScreenSourcePicker
      live={{ screenSourceChoices: choices, pickScreenSource: (id) => picks.push(id) }}
    />,
  );
  return picks;
}

test("Aiden's screen picker lists screens and windows as radios and shares the chosen one", async () => {
  const picks = mount(sources);
  await screen.findByRole("dialog", { name: "Choose what to share" });
  const group = screen.getByRole("radiogroup", { name: "Screens and windows" });
  const radios = group.querySelectorAll('[role="radio"]');
  assert.equal(radios.length, 2);
  // The first source starts selected, so Share works straight away.
  assert.equal(radios[0]?.getAttribute("aria-checked"), "true");
  screen.getByText("Entire screen");
  screen.getByText("Window");

  fireEvent.click(radios[1]!);
  assert.equal(radios[1]?.getAttribute("aria-checked"), "true");
  fireEvent.click(screen.getByRole("button", { name: "Share" }));
  assert.deepEqual(picks, ["window:9:0"]);
});

test("Cancel answers the picker with no source", async () => {
  const picks = mount(sources);
  fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  assert.deepEqual(picks, [null]);
});

test("no picker is shown when there is nothing to choose from", () => {
  mount(null);
  assert.ok(!screen.queryByRole("dialog"));
});
