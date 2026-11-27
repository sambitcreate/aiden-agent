import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { installBotTestIpc } from "../main/bots/test-dom";
import { modelOption, mountWithBotRouter } from "../main/bots/test-providers";
import { detectedKeyboardPlatform } from "../shared/keybindings";
import type { AppSettings, Provider } from "../lib/types";
import { ModelPicker } from "./model-picker";
import { Toaster } from "./ui";

afterEach(cleanup);

// A Bot's chat model picker: the searchable list, with the detail card beside it.

const provider: Provider = {
  id: "acme",
  kind: "openai-compatible" as Provider["kind"],
  label: "Acme Cloud",
  baseUrl: "https://acme.invalid/v1",
  models: ["placed-one", "placed-two", "current-model"],
  needsKey: false,
  hasKey: true,
};

function settingsServer(
  initial: AppSettings,
  options: { failWrites?: boolean } = {},
) {
  let current = structuredClone(initial);
  const calls = installBotTestIpc({
    "settings:get": () => structuredClone(current),
    "settings:set": (patch: unknown) => {
      if (options.failWrites) throw new Error("disk full");
      current = { ...current, ...(patch as Partial<AppSettings>) };
      return structuredClone(current);
    },
    "models:info": () => ({}),
  });
  return {
    calls,
    current: () => current,
  };
}

async function mountPicker(
  server: ReturnType<typeof settingsServer>,
  options: {
    hidden?: string[];
    onChange?: (providerId: string, model: string) => void;
    providers?: Provider[];
  } = {},
) {
  const { router } = await mountWithBotRouter(
    <>
      <ModelPicker
        providers={options.providers ?? [provider]}
        providerId="acme"
        model="current-model"
        onChange={options.onChange ?? (() => {})}
        hiddenModelsByProvider={options.hidden ? { acme: options.hidden } : undefined}
      />
      <Toaster />
    </>,
  );
  // Pins and recents load with the settings before the list opens.
  await act(async () => {
    await waitFor(() => assert.ok(server.calls.some((call) => call.channel === "settings:get")));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  fireEvent.click(screen.getByRole("button", { name: /Choose a model/u }));
  return router;
}

async function openList(
  server: ReturnType<typeof settingsServer>,
  options: Parameters<typeof mountPicker>[1] = {},
) {
  await mountPicker(server, options);
  return screen.findByLabelText("Filter chat models");
}

test("the side card names the other providers that serve the same model", async () => {
  const relay: Provider = {
    ...provider,
    id: "relay",
    label: "Relay Hub",
    baseUrl: "https://relay.invalid/v1",
    models: ["acme/current-model", "acme/placed-one"],
  };
  const server = settingsServer({});
  await openList(server, { providers: [provider, relay] });

  const card = await screen.findByRole("complementary");
  assert.match(card.textContent ?? "", /Current Model/u);
  assert.match(card.textContent ?? "", /Also via Relay Hub/u);
});

/** A row's mouse-only Pin action, by what pressing it does ("Pin", "Unpin"). */
function rowAction(label: string, action: string): HTMLElement {
  return within(modelOption(label)).getByTitle(new RegExp(`^${action} \\(`, "u"));
}

function rowDescription(label: string): string {
  const id = modelOption(label).getAttribute("aria-describedby");
  return (id && document.getElementById(id)?.textContent) || "";
}

/** The platform's Command+Shift+<letter> on the List's filter. */
function pressRowShortcut(filter: HTMLElement, letter: "P" | "A") {
  const primary = detectedKeyboardPlatform() === "darwin" ? { metaKey: true } : { ctrlKey: true };
  fireEvent.keyDown(filter, { key: letter, code: `Key${letter}`, shiftKey: true, ...primary });
}

test("list rows say whether each model is pinned, with no control inside the option and no Pad action", async () => {
  const server = settingsServer({ pinnedModels: ["acme::placed-two"] });
  const filter = await openList(server);

  assert.match(rowDescription("Placed One"), /Not pinned\. .* pins it\.$/u);
  assert.match(rowDescription("Placed Two"), /Pinned\. .* unpins it\.$/u);
  assert.doesNotMatch(rowDescription("Placed One"), /Pad/u);
  assert.ok(rowAction("Placed One", "Pin"));
  assert.ok(rowAction("Placed Two", "Unpin"));
  assert.equal(within(modelOption("Placed One")).queryByTitle(/Pad/u), null);
  // An option can't contain a focusable control (axe nested-interactive), and
  // its name is the model, not the actions' labels.
  for (const option of screen.getAllByRole("option")) {
    assert.equal(option.querySelectorAll("button, a[href], input, [tabindex]").length, 0);
    assert.ok(option.getAttribute("aria-keyshortcuts"));
  }
  assert.equal(screen.queryAllByRole("button", { name: /^(Pin|Unpin) |(to|from) Pad$/u }).length, 0);

  // The retired "add to Pad" shortcut does nothing now.
  pressRowShortcut(filter, "A");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(server.calls.filter((call) => call.channel === "settings:set").length, 0);
  assert.ok(filter.isConnected, "the list stayed open");
});

function actionAnnouncement(): string {
  const regions = [...document.querySelectorAll("[cmdk-root] [aria-live='polite']")];
  return regions.map((region) => region.textContent ?? "").join("|");
}

test("the Pin shortcut pins the highlighted row, says so, and keeps the list open", async () => {
  const server = settingsServer({});
  const changes: string[] = [];
  const search = await openList(server, {
    onChange: (providerId: string, model: string) => changes.push(`${providerId}::${model}`),
  });

  fireEvent.keyDown(search, { key: "ArrowUp" });
  await waitFor(() => assert.equal(modelOption("Placed Two").getAttribute("aria-selected"), "true"));
  pressRowShortcut(search, "P");

  await waitFor(() => assert.match(rowDescription("Placed Two"), /^.*\. Pinned\./u));
  // Said once the save has gone through.
  await waitFor(() => assert.match(actionAnnouncement(), /Pinned Placed Two/u));
  const writes = server.calls.filter((call) => call.channel === "settings:set");
  assert.deepEqual(
    writes.map((call) => (call.args[0] as AppSettings).pinnedModels),
    [["acme::placed-two"]],
  );
  assert.deepEqual(changes, []);
  assert.ok(search.isConnected, "the list stayed open");
});

test("a long List shows a page of models and a Show more row that reveals the rest", async () => {
  const many: Provider = {
    ...provider,
    models: Array.from({ length: 130 }, (_, index) => `bulk-${String(index).padStart(3, "0")}`),
  };
  const server = settingsServer({});
  await mountPicker(server, { providers: [many] });
  const search = await screen.findByLabelText("Filter chat models");
  const options = () => screen.getAllByRole("option");

  // 100 models and the Show more row.
  await waitFor(() => assert.equal(options().length, 101));
  assert.equal(options()[100].getAttribute("aria-label"), "Show 30 more, 30 not shown");

  // Keyboard: End reaches Show more, Enter reveals the rest and selects the
  // first model it revealed, in Show more's place.
  fireEvent.keyDown(search, { key: "End" });
  await waitFor(() => assert.equal(options()[100].getAttribute("aria-selected"), "true"));
  fireEvent.keyDown(search, { key: "Enter" });
  await waitFor(() => assert.equal(options().length, 130));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(options()[100].getAttribute("aria-selected"), "true");
  assert.match(options()[100].textContent ?? "", /bulk.?100/iu);
  assert.ok(search.isConnected, "Show more doesn't choose a model or close the picker");

  // A new query starts from one page again; the count names every match.
  fireEvent.change(search, { target: { value: "bulk" } });
  await waitFor(() => assert.equal(options().length, 101));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 550));
  });
  assert.match(actionAnnouncement(), /130 results/u);

  // Back to the empty filter, and closing and reopening, start from one page too.
  fireEvent.change(search, { target: { value: "" } });
  await waitFor(() => assert.equal(options().length, 101));
  fireEvent.keyDown(search, { key: "End" });
  fireEvent.keyDown(search, { key: "Enter" });
  await waitFor(() => assert.equal(options().length, 130));
  fireEvent.keyDown(search, { key: "Escape" });
  await waitFor(() => assert.ok(!search.isConnected));
  fireEvent.click(screen.getByRole("button", { name: /Choose a model/u }));
  await screen.findByLabelText("Filter chat models");
  await waitFor(() => assert.equal(options().length, 101));
});

test("the current model stays listed, selected and choosable when it falls past the first page", async () => {
  const many: Provider = {
    ...provider,
    models: [
      ...Array.from({ length: 130 }, (_, index) => `bulk-${String(index).padStart(3, "0")}`),
      "current-model",
    ],
  };
  const server = settingsServer({});
  await mountPicker(server, { providers: [many] });
  const search = await screen.findByLabelText("Filter chat models");
  const options = () => screen.getAllByRole("option");

  // 100 models, then the current one in its place, then Show more for the other 30.
  await waitFor(() => assert.equal(options().length, 102));
  const current = options()[100];
  assert.match(current.textContent ?? "", /Current Model/u);
  assert.equal(current.getAttribute("aria-selected"), "true");
  assert.equal(options()[101].getAttribute("aria-label"), "Show 30 more, 30 not shown");

  // Enter chooses it, which records it as the most recent model and closes the picker.
  fireEvent.keyDown(search, { key: "Enter" });
  await waitFor(() => assert.ok(!search.isConnected, "choosing closes the picker"));
  await waitFor(() => assert.deepEqual(savedRecents(server), [["acme::current-model"]]));
});

test("the list filter is cleared when the picker reopens", async () => {
  const server = settingsServer({});
  await mountPicker(server);
  const filter = (await screen.findByLabelText("Filter chat models")) as HTMLInputElement;
  fireEvent.change(filter, { target: { value: "pl" } });
  assert.equal(filter.value, "pl");

  fireEvent.keyDown(filter, { key: "Escape" });
  await waitFor(() => assert.ok(!screen.queryByLabelText("Filter chat models")));
  fireEvent.click(screen.getByRole("button", { name: /Choose a model/u }));

  const reopened = (await screen.findByLabelText("Filter chat models")) as HTMLInputElement;
  assert.equal(reopened.value, "");
});

const MODEL_LABELS = ["Current Model", "Placed One", "Placed Two"];

/** The model each listed row names, in list order. */
function optionNames(container: HTMLElement) {
  return within(container)
    .getAllByRole("option")
    .map((option) => MODEL_LABELS.find((label) => option.textContent?.includes(label)) ?? "");
}

function savedRecents(server: ReturnType<typeof settingsServer>) {
  return server.calls
    .filter((call) => call.channel === "settings:set")
    .map((call) => (call.args[0] as AppSettings).recentModels)
    .filter((recent) => recent !== undefined);
}

test("the List shows recent models after pinned ones, without the current model or duplicates", async () => {
  const server = settingsServer({
    pinnedModels: ["acme::current-model"],
    recentModels: ["acme::current-model", "acme::gone", "acme::placed-two", "acme::placed-one"],
  });
  await openList(server);

  const list = screen.getByRole("listbox");
  const recent = within(list).getByRole("group", { name: "Recent" });
  // Pinned first, then Recent (in recency order), then the rest. Every model is
  // listed once, and the pinned current model is not repeated under Recent.
  assert.deepEqual(optionNames(recent), ["Placed Two", "Placed One"]);
  assert.deepEqual(optionNames(list), ["Current Model", "Placed Two", "Placed One"]);
});

test("filtering the List shows a flat list without the Recent group", async () => {
  const server = settingsServer({ recentModels: ["acme::placed-two"] });
  const filter = (await openList(server)) as HTMLInputElement;
  assert.ok(screen.getByRole("group", { name: "Recent" }));

  fireEvent.change(filter, { target: { value: "placed" } });

  await waitFor(() => assert.ok(!screen.queryByRole("group", { name: "Recent" })));
  assert.deepEqual(optionNames(screen.getByRole("listbox")).sort(), ["Placed One", "Placed Two"]);
});

test("filtering marks the matched part of each label and matches the provider unmarked", async () => {
  const server = settingsServer({});
  const filter = await openList(server);
  const list = screen.getByRole("listbox");
  const marks = () => [...list.querySelectorAll("mark")].map((mark) => mark.textContent);

  fireEvent.change(filter, { target: { value: "two" } });
  await waitFor(() => assert.deepEqual(optionNames(list), ["Placed Two"]));
  assert.deepEqual(marks(), ["Two"]);

  // Initials: "pt" is Placed Two's word starts.
  fireEvent.change(filter, { target: { value: "pt" } });
  await waitFor(() => assert.deepEqual(optionNames(list), ["Placed Two"]));
  assert.deepEqual(marks(), ["P", "T"]);

  // The provider name matches every row without marking anything.
  fireEvent.change(filter, { target: { value: "acme" } });
  await waitFor(() => assert.equal(optionNames(list).length, 3));
  assert.deepEqual(marks(), []);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 550));
  });
  assert.equal(list.parentElement?.querySelector("[aria-live='polite']")?.textContent, "3 results");
});

test("choosing a model in the List records it as the most recent", async () => {
  const server = settingsServer({ recentModels: ["acme::placed-one"] });
  const changes: string[] = [];
  await openList(server, {
    onChange: (providerId: string, model: string) => changes.push(`${providerId}::${model}`),
  });

  fireEvent.click(screen.getByRole("option", { name: /Placed Two/u }));

  assert.deepEqual(changes, ["acme::placed-two"]);
  await waitFor(() =>
    assert.deepEqual(savedRecents(server), [["acme::placed-two", "acme::placed-one"]]),
  );
});

test("choosing the newest recent model again writes nothing", async () => {
  const server = settingsServer({ recentModels: ["acme::placed-two"] });
  const changes: string[] = [];
  await openList(server, {
    onChange: (providerId: string, model: string) => changes.push(`${providerId}::${model}`),
  });

  fireEvent.click(screen.getByRole("option", { name: /Placed Two/u }));

  assert.deepEqual(changes, ["acme::placed-two"]);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(server.calls.filter((call) => call.channel === "settings:set").length, 0);
});

test("a failed recents write neither blocks the choice nor shows an error", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const server = settingsServer({}, { failWrites: true });
  const changes: string[] = [];
  await openList(server, {
    onChange: (providerId: string, model: string) => changes.push(`${providerId}::${model}`),
  });

  fireEvent.click(screen.getByRole("option", { name: /Placed Two/u }));

  assert.deepEqual(changes, ["acme::placed-two"]);
  await waitFor(() => assert.equal(warn.mock.callCount(), 1));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.ok(!screen.queryByText(/disk full/u), "no error toast for history");
});

