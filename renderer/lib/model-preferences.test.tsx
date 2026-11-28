import "../main/bots/test-dom";
import assert from "node:assert/strict";
import * as React from "react";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { installBotTestIpc } from "../main/bots/test-dom";
import { createBotTestQueryClient } from "../main/bots/test-providers";
import { saveModelPreferences, useModelPreferences } from "./model-preferences";
import { queryKeys } from "./queries";
import type { AppSettings } from "./types";

afterEach(cleanup);

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

function PreferencesProbe() {
  const preferences = useModelPreferences();
  const [error, setError] = React.useState("");
  return (
    <div>
      <output aria-label="ready">{String(preferences.ready)}</output>
      <output aria-label="recents">{preferences.recentModels.join(",")}</output>
      <output aria-label="pins">{preferences.pinnedModels.join(",")}</output>
      <output aria-label="error">{error}</output>
      <button
        type="button"
        onClick={() => {
          preferences
            .save((current) => ({
              pinnedModels: [...current.pinnedModels, "google::gemini"],
              recentModels: ["google::gemini", ...current.recentModels],
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
      <PreferencesProbe />
    </QueryClientProvider>,
  );
  return client;
}

test("pins and recents read from settings and save through the settings patch", async () => {
  const server = settingsServer({
    // A hand-edited invalid entry must never reach list consumers.
    pinnedModels: ["openai::gpt", "broken"],
    recentModels: ["openai::gpt"],
    exaEnabled: true,
  });
  mount();

  await waitFor(() => assert.equal(screen.getByLabelText("ready").textContent, "true"));
  assert.equal(screen.getByLabelText("pins").textContent, "openai::gpt");
  assert.equal(screen.getByLabelText("recents").textContent, "openai::gpt");

  fireEvent.click(screen.getByRole("button", { name: "Add Gemini" }));

  await waitFor(() =>
    assert.equal(screen.getByLabelText("recents").textContent, "google::gemini,openai::gpt"),
  );
  assert.equal(screen.getByLabelText("pins").textContent, "openai::gpt,google::gemini");
  const writes = server.calls.filter((call) => call.channel === "settings:set");
  assert.equal(writes.length, 1);
  assert.deepEqual(Object.keys(writes[0].args[0] as object).sort(), [
    "pinnedModels",
    "recentModels",
  ]);
  assert.equal(server.current().exaEnabled, true);
  assert.deepEqual(server.current().pinnedModels, ["openai::gpt", "google::gemini"]);
});

test("a failed save rejects and restores the persisted settings", async () => {
  settingsServer({ pinnedModels: ["openai::gpt"] }, true);
  mount();
  await waitFor(() => assert.equal(screen.getByLabelText("ready").textContent, "true"));

  fireEvent.click(screen.getByRole("button", { name: "Add Gemini" }));

  await waitFor(() => assert.match(screen.getByLabelText("error").textContent ?? "", /disk full/u));
  await waitFor(() => assert.equal(screen.getByLabelText("pins").textContent, "openai::gpt"));
  assert.equal(screen.getByLabelText("recents").textContent, "");
});

test("overlapping pin saves never lose an update when replies arrive late", async () => {
  let server: AppSettings = { pinnedModels: [], exaEnabled: true };
  const replies: Array<() => void> = [];
  installBotTestIpc({
    "settings:get": () => structuredClone(server),
    // Applies each patch on arrival, in order, but answers only when released.
    "settings:set": (patch: unknown) => {
      server = { ...server, ...(patch as Partial<AppSettings>) };
      const reply = structuredClone(server);
      return new Promise<AppSettings>((resolve) => replies.push(() => resolve(reply)));
    },
  });
  const client = createBotTestQueryClient();
  await client.fetchQuery({
    queryKey: queryKeys.settings,
    queryFn: async () => structuredClone(server),
  });
  const toggle = (value: string) =>
    saveModelPreferences(client, ({ pinnedModels }) => ({
      pinnedModels: pinnedModels.includes(value)
        ? pinnedModels.filter((entry) => entry !== value)
        : [...pinnedModels, value],
    }));
  const cachedPins = () => client.getQueryData<AppSettings>(queryKeys.settings)?.pinnedModels;
  const releaseNext = async () => {
    await waitFor(() => assert.ok(replies.length > 0));
    replies.shift()!();
  };

  const saves = [toggle("p::x"), toggle("p::y")];
  await waitFor(() => assert.deepEqual(cachedPins(), ["p::x", "p::y"]));
  await releaseNext(); // the reply to x lands while y is still in flight
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(cachedPins(), ["p::x", "p::y"]);
  saves.push(toggle("p::z"));
  await waitFor(() => assert.deepEqual(cachedPins(), ["p::x", "p::y", "p::z"]));
  await releaseNext();
  await releaseNext();
  await Promise.all(saves);

  assert.deepEqual(server.pinnedModels, ["p::x", "p::y", "p::z"]);
  assert.deepEqual(cachedPins(), ["p::x", "p::y", "p::z"]);
  assert.equal(server.exaEnabled, true);
});

test("an update that changes nothing sends no write and leaves the cache alone", async () => {
  const initial: AppSettings = { pinnedModels: ["p::x"] };
  const server = settingsServer(initial);
  const client = createBotTestQueryClient();
  await client.fetchQuery({
    queryKey: queryKeys.settings,
    queryFn: async () => structuredClone(initial),
  });
  const before = client.getQueryData<AppSettings>(queryKeys.settings);

  const result = await saveModelPreferences(client, () => ({}));

  assert.ok(!server.calls.some((call) => call.channel === "settings:set"));
  assert.equal(client.getQueryData<AppSettings>(queryKeys.settings), before);
  assert.deepEqual(result.pinnedModels, ["p::x"]);
});
