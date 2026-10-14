import { installBotTestIpc } from "./test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { BotDefinition, BotUpdateInput } from "../../shared/bots";
import { toast } from "../../components/ui";
import { APPEARANCE_CHANGE_EVENT } from "../../lib/appearance-runtime";
import { BotsView } from "../bots-view";
import { botFixture, catalogFixture } from "./test-fixtures";
import { mountWithBotRouter } from "./test-providers";

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.reduceMotion;
});

/** The test DOM does not mount sonner's viewport, so observe the errors the person would be shown. */
function captureErrorToasts(): { shown: string[]; restore(): void } {
  const shown: string[] = [];
  const original = toast.error;
  toast.error = ((message: unknown) => {
    shown.push(String(message));
    return "toast";
  }) as typeof toast.error;
  return { shown, restore: () => void (toast.error = original) };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function store(
  initial: BotDefinition,
  options: {
    failUpdate?: boolean;
    /** Awaited before the nth (0-based) update applies; a rejection fails that save. */
    gate?: (call: number) => Promise<void> | undefined;
  } = {},
) {
  let bot = initial;
  const updates: BotUpdateInput[] = [];
  installBotTestIpc({
    "bots:list": () => [bot],
    "bots:get": () => bot,
    "bots:update": async (input) => {
      const update = input as BotUpdateInput;
      updates.push(update);
      await options.gate?.(updates.length - 1);
      if (options.failUpdate) throw new Error("This Bot changed on another surface. Refresh it and try again.");
      const { id: _id, expectedRevision: _revision, ...fields } = update;
      bot = { ...bot, ...fields, revision: `${bot.revision}+` };
      return bot;
    },
    "bots:getCapabilityCatalog": () => catalogFixture(),
    "bots:getBotAccess": () => ({
      access: { botId: "bot-1", revision: "acc-1", policyEpoch: "e", summary: "", accessMode: "full" },
      modelSelection: { providerId: "prov-text", modelId: "model-text" },
      visionModelSelection: { providerId: "prov-vision", modelId: "model-vision" },
    }),
    "bots:getTelegramBinding": () => null,
  });
  return { updates, current: () => bot, change: (next: BotDefinition) => void (bot = next) };
}

test("Advanced shows the current choice and opens Chat activity; Back returns to Advanced", async () => {
  store(botFixture({ chatActivity: { level: "summary", wording: "follows" } }));
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1?page=advanced" });
  const row = await screen.findByRole("button", { name: "Chat activity" });
  assert.ok(within(row).getByText("Summary · Follows the work"));
  fireEvent.click(row);
  assert.ok(await screen.findByRole("heading", { name: "Chat activity" }));
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  assert.ok(await screen.findByRole("radiogroup", { name: "What it can use" }));
});

test("the Advanced row shows the new choice after a pick and Back", async () => {
  store(botFixture());
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1?page=advanced" });
  fireEvent.click(await screen.findByRole("button", { name: "Chat activity" }));
  const level = await screen.findByRole("radiogroup", { name: "How much to show" });
  fireEvent.click(within(level).getByRole("radio", { name: "Detailed" }));
  await waitFor(() =>
    assert.equal(within(level).getByRole("radio", { name: "Detailed" }).getAttribute("data-state"), "checked"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  const row = await screen.findByRole("button", { name: "Chat activity" });
  await waitFor(() => assert.ok(within(row).getByText("Detailed · Follows the work")));
});

test("each choice saves as it is picked, with the Bot's revision and nothing else changed", async () => {
  const bots = store(botFixture());
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1?page=chat-activity" });
  const level = await screen.findByRole("radiogroup", { name: "How much to show" });
  assert.equal(within(level).getByRole("radio", { name: "Quiet" }).getAttribute("data-state"), "checked");
  fireEvent.click(within(level).getByRole("radio", { name: "Detailed" }));
  await waitFor(() => assert.equal(bots.updates.length, 1));
  assert.deepEqual(bots.updates[0]!.chatActivity, { level: "detailed", wording: "follows" });
  assert.equal(bots.updates[0]!.expectedRevision, "rev-1");
  assert.equal(bots.updates[0]!.name, "Planner");
  const wording = screen.getByRole("radiogroup", { name: "What the status line says" });
  fireEvent.click(within(wording).getByRole("radio", { name: "Always “Thinking”" }));
  await waitFor(() => assert.equal(bots.updates.length, 2));
  assert.deepEqual(bots.updates[1]!.chatActivity, { level: "detailed", wording: "thinking" });
  assert.equal(bots.updates[1]!.expectedRevision, "rev-1+");
  assert.ok(!screen.queryByRole("button", { name: "Save" }), "no Save button on this page");
});

test("a choice that fails to save goes back to the saved one and says so", async () => {
  const toasts = captureErrorToasts();
  try {
    store(botFixture(), { failUpdate: true });
    await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1?page=chat-activity" });
    const level = await screen.findByRole("radiogroup", { name: "How much to show" });
    fireEvent.click(within(level).getByRole("radio", { name: "Summary" }));
    await waitFor(() => assert.equal(toasts.shown.length, 1));
    assert.equal(toasts.shown[0], "This Bot changed on another surface. Refresh it and try again.");
    await waitFor(() =>
      assert.equal(within(level).getByRole("radio", { name: "Quiet" }).getAttribute("data-state"), "checked"),
    );
    assert.equal(within(level).getByRole("radio", { name: "Summary" }).getAttribute("data-state"), "unchecked");
  } finally {
    toasts.restore();
  }
});

test("a failure with no message says Aiden couldn’t save the choice", async () => {
  const toasts = captureErrorToasts();
  try {
    store(botFixture(), {
      gate: () => Promise.reject(new Error("")),
    });
    await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1?page=chat-activity" });
    const wording = await screen.findByRole("radiogroup", { name: "What the status line says" });
    fireEvent.click(within(wording).getByRole("radio", { name: "Always “Thinking”" }));
    await waitFor(() => assert.deepEqual(toasts.shown, ["Aiden couldn’t save that choice."]));
    await waitFor(() =>
      assert.equal(within(wording).getByRole("radio", { name: "Follows the work" }).getAttribute("data-state"), "checked"),
    );
  } finally {
    toasts.restore();
  }
});

test("two quick picks save in order, the second built on the first's saved choice", async () => {
  const first = deferred();
  const bots = store(botFixture(), { gate: (call) => (call === 0 ? first.promise : undefined) });
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1?page=chat-activity" });
  const level = await screen.findByRole("radiogroup", { name: "How much to show" });
  const wording = screen.getByRole("radiogroup", { name: "What the status line says" });
  fireEvent.click(within(level).getByRole("radio", { name: "Detailed" }));
  await waitFor(() => assert.equal(bots.updates.length, 1));
  fireEvent.click(within(wording).getByRole("radio", { name: "Always “Thinking”" }));
  // Both choices show at once, but the second save waits for the first.
  assert.equal(within(level).getByRole("radio", { name: "Detailed" }).getAttribute("data-state"), "checked");
  assert.equal(within(wording).getByRole("radio", { name: "Always “Thinking”" }).getAttribute("data-state"), "checked");
  assert.equal(bots.updates.length, 1);
  first.resolve();
  await waitFor(() => assert.equal(bots.updates.length, 2));
  assert.deepEqual(bots.updates[0]!.chatActivity, { level: "detailed", wording: "follows" });
  assert.deepEqual(bots.updates[1]!.chatActivity, { level: "detailed", wording: "thinking" });
  assert.equal(bots.updates[1]!.expectedRevision, "rev-1+");
});

test("a failed save does not leak into the next one, and the radios settle on what was saved", async () => {
  const toasts = captureErrorToasts();
  try {
    const first = deferred();
    const bots = store(botFixture(), { gate: (call) => (call === 0 ? first.promise : undefined) });
    await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1?page=chat-activity" });
    const level = await screen.findByRole("radiogroup", { name: "How much to show" });
    const wording = screen.getByRole("radiogroup", { name: "What the status line says" });
    fireEvent.click(within(level).getByRole("radio", { name: "Detailed" }));
    await waitFor(() => assert.equal(bots.updates.length, 1));
    fireEvent.click(within(wording).getByRole("radio", { name: "Always “Thinking”" }));
    first.reject(new Error("This Bot changed on another surface. Refresh it and try again."));
    await waitFor(() => assert.equal(bots.updates.length, 2));
    // The second save carries only its own choice; the failed Detailed is not applied.
    assert.deepEqual(bots.updates[1]!.chatActivity, { level: "quiet", wording: "thinking" });
    await waitFor(() =>
      assert.equal(within(level).getByRole("radio", { name: "Quiet" }).getAttribute("data-state"), "checked"),
    );
    assert.equal(within(wording).getByRole("radio", { name: "Always “Thinking”" }).getAttribute("data-state"), "checked");
    assert.equal(toasts.shown.length, 1);
    assert.deepEqual(bots.current().chatActivity, { level: "quiet", wording: "thinking" });
  } finally {
    toasts.restore();
  }
});

test("a pick changes only that field, even when the Bot changed elsewhere since the page opened", async () => {
  const bots = store(botFixture());
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1?page=chat-activity" });
  const wording = await screen.findByRole("radiogroup", { name: "What the status line says" });
  // Another surface chose Summary after this page opened.
  bots.change(botFixture({ revision: "rev-2", chatActivity: { level: "summary", wording: "follows" } }));
  fireEvent.click(within(wording).getByRole("radio", { name: "Always “Thinking”" }));
  await waitFor(() => assert.equal(bots.updates.length, 1));
  assert.deepEqual(bots.updates[0]!.chatActivity, { level: "summary", wording: "thinking" });
  assert.equal(bots.updates[0]!.expectedRevision, "rev-2");
});

test("each choice names its description and badge for assistive tech", async () => {
  store(botFixture());
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1?page=chat-activity" });
  const level = await screen.findByRole("radiogroup", { name: "How much to show" });
  const described = (name: string) => {
    const ids = (within(level).getByRole("radio", { name }).getAttribute("aria-describedby") ?? "").split(" ");
    return ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
  };
  assert.equal(described("Quiet"), "Recommended One line that says what it’s doing.");
  assert.equal(described("Summary"), "Adds a short recap above each reply.");
});

test("under Reduce Motion each preview is a still frame with Play, built from the real status line", async () => {
  document.documentElement.dataset.reduceMotion = "true";
  store(botFixture());
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1?page=chat-activity" });
  await screen.findByRole("radiogroup", { name: "How much to show" });
  const preview = (name: string) =>
    document.querySelector(`[data-bot-chat-activity-preview="${name}"]`) as HTMLElement;
  const follows = preview("wording-follows");
  const thinking = preview("wording-thinking");
  assert.ok(follows.querySelector('[data-bot-status-phase="searching"]'));
  assert.ok(thinking.querySelector('[data-bot-status-phase="thinking"]'));
  assert.ok(within(follows).getAllByText("Searching the web").length > 0);
  assert.ok(within(thinking).getAllByText("Thinking").length > 0);
  // Each level's still frame shows what it adds.
  assert.ok(!preview("level-quiet").querySelector("[data-bot-recap]"));
  assert.ok(preview("level-quiet").querySelector("[data-bot-status-phase]"));
  assert.equal(preview("level-summary").querySelector("[data-bot-recap]")?.getAttribute("data-bot-recap"), "done");
  assert.equal(preview("level-detailed").querySelector("[data-bot-recap]")?.getAttribute("data-bot-recap"), "live");
  const play = screen.getByRole("button", { name: "Play preview: Detailed" });
  fireEvent.click(play);
  assert.ok(screen.getByRole("button", { name: "Pause preview: Detailed" }));
  // The phones group explains that phones always show just the line.
  assert.ok(screen.getByText("Always just the line, with the same words."));
});

test("turning Reduce Motion off while the page is open starts the previews", async () => {
  document.documentElement.dataset.reduceMotion = "true";
  store(botFixture());
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1?page=chat-activity" });
  await screen.findByRole("button", { name: "Play preview: Detailed" });
  document.documentElement.dataset.reduceMotion = "false";
  window.dispatchEvent(new CustomEvent(APPEARANCE_CHANGE_EVENT));
  await waitFor(() => assert.ok(!screen.queryByRole("button", { name: "Play preview: Detailed" })));
});
