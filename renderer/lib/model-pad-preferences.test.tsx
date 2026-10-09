import "../main/bots/test-dom";
import assert from "node:assert/strict";
import * as React from "react";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { installBotTestIpc } from "../main/bots/test-dom";
import { createBotTestQueryClient } from "../main/bots/test-providers";
import { useModelPadLayout, useModelPadPreferences } from "./model-pad-preferences";
import type { AppSettings } from "./types";

afterEach(cleanup);

const user = { xSource: "user", ySource: "user" } as const;

function settingsServer(initial: AppSettings, failWrites = false) {
  let current = structuredClone(initial);
  const calls = installBotTestIpc({
    "settings:get": () => structuredClone(current),
    "settings:set": (patch: unknown) => {
      if (failWrites) throw new Error("disk full");
      current = { ...current, ...(patch as Partial<AppSettings>) };
      return structuredClone(current);
    },
  });
  return { calls, current: () => current };
}

function PadProbe() {
  const layout = useModelPadLayout();
  const preferences = useModelPadPreferences();
  const [error, setError] = React.useState("");
  return (
    <div>
      <output aria-label="ready">{String(preferences.ready)}</output>
      <output aria-label="placements">{Object.keys(layout.placements).sort().join(",")}</output>
      <output aria-label="pins">{preferences.pinnedModels.join(",")}</output>
      <output aria-label="error">{error}</output>
      <button
        type="button"
        onClick={() => {
          preferences
            .save((current) => ({
              modelPadPlacements: {
                ...current.placements,
                "google::gemini": { x: 0, y: 1, ...user },
              },
              pinnedModels: [...current.pinnedModels, "google::gemini"],
            }))
            .catch((reason: unknown) => setError(String(reason)));
        }}
      >
        Add Gemini
      </button>
    </div>
  );
}


function mount() {
  const client = createBotTestQueryClient();
  render(
    <QueryClientProvider client={client}>
      <PadProbe />
    </QueryClientProvider>,
  );
  return client;
}

test("Pad layout and pins read from settings and save through the settings patch", async () => {
  const server = settingsServer({
    modelPadPlacements: {
      "openai::gpt": { x: 0.5, y: 0.5, ...user },
      // A hand-edited invalid entry must never reach Pad consumers.
      "openai::broken": { x: 9, y: 0.5, ...user },
    },
    pinnedModels: ["openai::gpt"],
    exaEnabled: true,
  });
  mount();

  await waitFor(() => assert.equal(screen.getByLabelText("ready").textContent, "true"));
  assert.equal(screen.getByLabelText("placements").textContent, "openai::gpt");
  assert.equal(screen.getByLabelText("pins").textContent, "openai::gpt");

  fireEvent.click(screen.getByRole("button", { name: "Add Gemini" }));

  await waitFor(() =>
    assert.equal(screen.getByLabelText("placements").textContent, "google::gemini,openai::gpt"),
  );
  assert.equal(screen.getByLabelText("pins").textContent, "openai::gpt,google::gemini");
  const writes = server.calls.filter((call) => call.channel === "settings:set");
  assert.equal(writes.length, 1);
  assert.deepEqual(Object.keys(writes[0].args[0] as object).sort(), [
    "modelPadPlacements",
    "pinnedModels",
  ]);
  assert.equal(server.current().exaEnabled, true);
  assert.deepEqual(server.current().pinnedModels, ["openai::gpt", "google::gemini"]);
});

test("a failed Pad save rejects and restores the persisted settings", async () => {
  settingsServer({ pinnedModels: ["openai::gpt"] }, true);
  mount();
  await waitFor(() => assert.equal(screen.getByLabelText("ready").textContent, "true"));

  fireEvent.click(screen.getByRole("button", { name: "Add Gemini" }));

  await waitFor(() => assert.match(screen.getByLabelText("error").textContent ?? "", /disk full/u));
  await waitFor(() => assert.equal(screen.getByLabelText("pins").textContent, "openai::gpt"));
  assert.equal(screen.getByLabelText("placements").textContent, "");
});
