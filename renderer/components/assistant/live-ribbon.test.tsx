import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { LiveActivityStore, type LiveActivity } from "../../lib/live-activity";
import { LiveSessionBus } from "../../lib/live-session-bus";
import { AidenLiveVoiceAndLookFields } from "../settings/aiden-live-voice-settings";
import { idleLiveController } from "./assistant-live-test-fixture";
import { LiveRibbon, LiveRibbonMenuItems } from "./live-ribbon";
import { AssistantDockPresentation } from "./assistant-dock";
import { measureLiveRibbonFootprint, placeLiveRibbon } from "./use-live-ribbon-placement";
import { useLiveVoiceEnding, waitForLivePlayback } from "./live-ribbon-session";
import type { AidenLiveMarkState } from "./aiden-live-mark";
import { createLivePreferenceSaver, type AidenLivePreferencesPatch } from "./use-aiden-live-preferences";
import type { AppSettings } from "../../lib/types";
import type { AssistantLiveController } from "./use-assistant-live";

afterEach(cleanup);

const PREFERENCES = { voice: "Puck", speed: 1 as const, ribbonColors: "spectrum" as const };
const openLive: AssistantLiveController = { ...idleLiveController, active: true, state: "open", microphoneActive: true };

function renderRibbon({
  live = openLive,
  markState = "listening",
  activity = null,
}: { live?: AssistantLiveController; markState?: AidenLiveMarkState; activity?: LiveActivity | null } = {}) {
  return render(
    <LiveRibbon
      live={live}
      markState={markState}
      activity={activity}
      preferences={PREFERENCES}
      onPreferencesChange={() => undefined}
    />,
  );
}

function buttonNames(): string[] {
  const pill = screen.getByRole("region", { name: "Aiden Live" });
  return within(pill)
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label") ?? button.textContent ?? "");
}

test("while Live listens the pill offers mute, the voice menu and End, and says it is listening", () => {
  renderRibbon();
  assert.deepEqual(buttonNames(), ["Mute microphone", "Voice, speed and colours", "End Live"]);
  assert.equal(screen.getByRole("status").textContent, "Listening");
});

test("the captions card shows only the latest line from you and from Live", () => {
  renderRibbon({
    live: {
      ...openLive,
      captions: [
        { id: 1, direction: "input", text: "Open settings", final: true, sealed: true },
        { id: 2, direction: "output", text: "Opening Settings.", final: true, sealed: true },
        { id: 3, direction: "input", text: "Now turn on OpenRouter", final: true, sealed: false },
        { id: 4, direction: "output", text: "Turning it on.", final: false, sealed: false },
      ],
    },
    markState: "speaking",
  });
  const log = screen.getByRole("log", { name: "Live captions" });
  assert.deepEqual(
    Array.from(log.querySelectorAll("p")).map((line) => line.textContent),
    ["You Now turn on OpenRouter", "Aiden Turning it on."],
  );
  assert.equal(screen.getByRole("status").textContent, "Speaking");
});

test("mute and End reach the session, and Esc on the pill ends Live", () => {
  const calls: string[] = [];
  const live: AssistantLiveController = {
    ...openLive,
    setMicrophoneMuted: (muted) => calls.push(`muted:${muted}`),
    stop: async () => {
      calls.push("stop");
    },
  };
  const { rerender } = renderRibbon({ live });
  fireEvent.click(screen.getByRole("button", { name: "Mute microphone" }));
  rerender(
    <LiveRibbon
      live={{ ...live, microphoneMuted: true }}
      markState="listening"
      activity={null}
      preferences={PREFERENCES}
      onPreferencesChange={() => undefined}
    />,
  );
  const mute = screen.getByRole("button", { name: "Mute microphone" });
  assert.equal(mute.getAttribute("aria-pressed"), "true");
  assert.equal(screen.getByRole("status").textContent, "Live · mic off");
  fireEvent.click(screen.getByRole("button", { name: "End Live" }));
  fireEvent.keyDown(mute, { key: "Escape" });
  assert.deepEqual(calls, ["muted:true", "stop", "stop"]);
});

test("while Live acts in Aiden the pill says what it is doing and Take over hands control back", () => {
  let tookOver = 0;
  renderRibbon({
    markState: "acting",
    activity: { kind: "acting", label: "Opening Settings", takeOver: () => (tookOver += 1) },
  });
  assert.equal(screen.getByRole("status").textContent, "Opening Settings");
  assert.ok(screen.getByText("Live is using Aiden"));
  assert.deepEqual(buttonNames(), ["Take over"]);
  fireEvent.click(screen.getByRole("button", { name: "Take over" }));
  assert.equal(tookOver, 1);
});

test("an approval shows its request and chat with Allow and Deny, and the voice hint only when voice can answer", () => {
  const answers: string[] = [];
  const approval = (voice: boolean): Extract<LiveActivity, { kind: "approval" }> => ({
    kind: "approval",
    id: "a1",
    title: "Run npm test?",
    chatTitle: "Fix login redirect",
    voice,
    allow: () => answers.push("allow"),
    deny: () => answers.push("deny"),
  });
  const { unmount } = renderRibbon({ activity: approval(true) });
  assert.ok(screen.getByText("Run npm test?"));
  assert.ok(screen.getByText("In Fix login redirect"));
  assert.ok(screen.getByText("Say “allow” or “deny”"));
  assert.deepEqual(buttonNames(), ["Deny", "Allow"]);
  fireEvent.click(screen.getByRole("button", { name: "Allow" }));
  fireEvent.click(screen.getByRole("button", { name: "Deny" }));
  assert.deepEqual(answers, ["allow", "deny"]);
  assert.equal(screen.getByRole("status").textContent, "Needs you: Run npm test?");
  unmount();

  const second = renderRibbon({ activity: approval(false) });
  assert.equal(screen.queryByText("Say “allow” or “deny”"), null);
  assert.deepEqual(buttonNames(), ["Deny", "Allow"]);
  second.unmount();

  // An approval the ribbon cannot allow offers only Deny and sends the user to the chat.
  renderRibbon({ activity: { ...approval(true), allow: undefined } });
  assert.deepEqual(buttonNames(), ["Deny"]);
  assert.ok(screen.getByText("Open “Fix login redirect” to choose"));
  assert.ok(screen.getByText("Say “deny”"));
  assert.equal(screen.queryByText("Say “allow” or “deny”"), null);
});

test("every control on the ribbon sits inside the region Live may never press", () => {
  renderRibbon({
    activity: {
      kind: "approval",
      id: "a1",
      title: "Run npm test?",
      chatTitle: "Fix login redirect",
      voice: true,
      allow: () => undefined,
      deny: () => undefined,
    },
  });
  const region = screen.getByRole("region", { name: "Aiden Live" });
  assert.equal(region.closest('[data-live-guard="you"]'), region);
  for (const button of within(region).getAllByRole("button")) {
    assert.ok(button.closest('[data-live-guard="you"]'), button.textContent ?? "");
  }
  cleanup();
  renderRibbon();
  const listening = screen.getByRole("region", { name: "Aiden Live" });
  for (const name of ["Mute microphone", "End Live"]) {
    assert.ok(within(listening).getByRole("button", { name }).closest('[data-live-guard="you"]'), name);
  }
});

test("the ••• menu and its voice list are guarded too, though they open outside the ribbon", async () => {
  renderRibbon();
  const trigger = screen.getByRole("button", { name: "Voice, speed and colours" });
  await act(async () => {
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
  });
  const menu = await screen.findByRole("menu");
  assert.equal(menu.closest(".live-ribbon"), null, "the menu is portaled out of the ribbon");
  assert.ok(menu.closest('[data-live-guard="you"]'));
  const voice = within(menu).getByRole("menuitem", { name: /Voice/u });
  await act(async () => {
    voice.focus();
    fireEvent.keyDown(voice, { key: "ArrowRight" });
  });
  const voices = await screen.findByRole("group", { name: "Voice" });
  assert.ok(voices.closest('[data-live-guard="you"]'));
  for (const item of within(voices).getAllByRole("menuitemradio")) {
    assert.ok(item.closest('[data-live-guard="you"]'));
  }
});

test("a spoken confirmation shows Confirm and Cancel with its phrase", () => {
  const answers: string[] = [];
  renderRibbon({
    activity: {
      kind: "confirm",
      id: "c1",
      label: "Delete the chat “Fix login”",
      confirm: () => answers.push("confirm"),
      cancel: () => answers.push("cancel"),
    },
  });
  assert.ok(screen.getByText("Delete the chat “Fix login”"));
  assert.ok(screen.getByText("Say “yes, do it”"));
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  assert.deepEqual(answers, ["confirm", "cancel"]);
});

function renderMenu(onChange: (patch: AidenLivePreferencesPatch) => void, voiceOpen = false) {
  return render(
    <DropdownMenuPrimitive.Root open modal={false}>
      <DropdownMenuPrimitive.Trigger>Live options</DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Content>
        <DropdownMenuPrimitive.Sub open={voiceOpen}>
          <LiveRibbonMenuItems
            preferences={{ voice: "Kore", speed: 1.25, ribbonColors: "spectrum" }}
            onChange={onChange}
          />
        </DropdownMenuPrimitive.Sub>
      </DropdownMenuPrimitive.Content>
    </DropdownMenuPrimitive.Root>,
  );
}

test("the ••• menu checks the current speed and colours and saves a new choice", () => {
  const patches: AidenLivePreferencesPatch[] = [];
  renderMenu((patch) => patches.push(patch));
  const checked = screen
    .getAllByRole("menuitemradio")
    .filter((item) => item.getAttribute("aria-checked") === "true")
    .map((item) => item.textContent);
  assert.deepEqual(checked, ["1.25×", "Spectrum"]);
  assert.deepEqual(
    screen.getAllByRole("menuitemradio").map((item) => item.textContent),
    ["0.75×", "1×", "1.25×", "1.5×", "2×", "Spectrum", "Theme accent"],
  );
  fireEvent.click(screen.getByRole("menuitemradio", { name: "2×" }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Theme accent" }));
  assert.deepEqual(patches, [{ aidenLiveSpeed: 2 }, { aidenLiveRibbonColors: "accent" }]);
});

test("the voice list offers every Live voice with its character, checks the current one and says when it applies", async () => {
  const patches: AidenLivePreferencesPatch[] = [];
  renderMenu((patch) => patches.push(patch));
  const trigger = screen.getByRole("menuitem", { name: /Voice/u });
  assert.match(trigger.textContent ?? "", /Kore/u);
  await act(async () => {
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowRight" });
  });
  const voices = await screen.findByRole("group", { name: "Voice" });
  const items = within(voices).getAllByRole("menuitemradio");
  assert.equal(items.length, 30);
  assert.equal(items[0]!.textContent, "PuckUpbeat");
  assert.deepEqual(
    items.filter((item) => item.getAttribute("aria-checked") === "true").map((item) => item.textContent),
    ["KoreFirm"],
  );
  assert.ok(screen.getByText("New voice starts next time"));
  fireEvent.click(within(voices).getByRole("menuitemradio", { name: /Charon/u }));
  assert.deepEqual(patches, [{ aidenLiveVoice: "Charon" }]);
});

test("Settings shows Voice, Speaking speed and Ribbon colours with the saved choices", () => {
  render(
    <AidenLiveVoiceAndLookFields
      preferences={{ voice: "Kore", speed: 1.5, ribbonColors: "accent" }}
      onChange={() => undefined}
    />,
  );
  assert.ok(screen.getByText("Voice and look"));
  assert.equal(screen.getByRole("combobox", { name: "Live voice" }).textContent, "Kore · Firm");
  assert.equal(screen.getByRole("combobox", { name: "Live speaking speed" }).textContent, "1.5×");
  assert.equal(screen.getByRole("combobox", { name: "Live ribbon colours" }).textContent, "Theme accent");
  assert.ok(screen.getByText("How Live sounds. A new voice starts the next time you start Live."));
});

// ---- Saving choices ----

test("a quick run of menu choices saves in order and ends on the last one", async () => {
  let stored = { aidenLiveSpeed: 1 } as unknown as AppSettings;
  let shown = stored;
  const pending: Array<{ patch: AidenLivePreferencesPatch; resolve(): void }> = [];
  let reloads = 0;
  let errors = 0;
  const save = createLivePreferenceSaver({
    read: () => shown,
    write: (next) => void (shown = next),
    persist: (patch) =>
      new Promise<AppSettings>((resolve) =>
        pending.push({
          patch,
          resolve: () => {
            stored = { ...stored, ...patch };
            resolve(stored);
          },
        }),
      ),
    reload: () => void (reloads += 1),
    onError: () => void (errors += 1),
  });
  const speed = () => (shown as unknown as { aidenLiveSpeed: number }).aidenLiveSpeed;
  const first = save({ aidenLiveSpeed: 1.5 });
  const second = save({ aidenLiveSpeed: 2 });
  assert.equal(speed(), 2, "the newest choice shows at once");
  await tick();
  assert.equal(pending.length, 1, "the second save waits for the first");
  pending[0]!.resolve();
  await first;
  assert.equal(speed(), 2, "the first save's reply does not undo the newer choice");
  await tick();
  assert.equal(pending.length, 2);
  pending[1]!.resolve();
  await second;
  assert.equal(speed(), 2);
  assert.equal((stored as unknown as { aidenLiveSpeed: number }).aidenLiveSpeed, 2, "the last choice is what was saved");
  assert.equal(reloads + errors, 0);

  const failing = createLivePreferenceSaver({
    read: () => shown,
    write: (next) => void (shown = next),
    persist: async () => {
      throw new Error("disk full");
    },
    reload: () => void (reloads += 1),
    onError: () => void (errors += 1),
  });
  await failing({ aidenLiveSpeed: 0.75 });
  assert.deepEqual([errors, reloads], [1, 1], "a failed save says so and reloads the saved choice");
});

// ---- Where the ribbon sits ----

test("a ribbon dragged to a window edge keeps its captions and approval cards inside the window", () => {
  const sized = (element: HTMLElement, width: number, height: number) => {
    Object.defineProperty(element, "offsetWidth", { configurable: true, value: width });
    Object.defineProperty(element, "offsetHeight", { configurable: true, value: height });
    return element;
  };
  const section = sized(document.createElement("section"), 380, 64 + 8 + 70 + 8 + 160);
  section.append(
    sized(document.createElement("div"), 440, 70), // captions, wider than the pill
    sized(document.createElement("div"), 380, 160), // an approval card
    sized(document.createElement("div"), 380, 64), // the pill
  );
  const footprint = measureLiveRibbonFootprint(section);
  assert.deepEqual(footprint, { width: 440, height: 310 });

  const viewport = { width: 1000, height: 700 };
  const anchor = { centerX: 500, bottom: 120 };
  // Dragged far up and left: the cards' top and the captions' left edge stay on screen.
  const placed = placeLiveRibbon(anchor, { x: -2_000, y: -2_000 }, footprint, viewport);
  assert.ok(placed.left - footprint.width / 2 >= 0, `left edge at ${placed.left - footprint.width / 2}`);
  assert.ok(placed.bottom + footprint.height <= viewport.height, `top edge at ${viewport.height - placed.bottom - footprint.height}`);
  // Dragged far down and right: the pill's bottom and the captions' right edge stay on screen.
  const corner = placeLiveRibbon(anchor, { x: 2_000, y: 2_000 }, footprint, viewport);
  assert.ok(corner.left + footprint.width / 2 <= viewport.width);
  assert.ok(corner.bottom >= 0);
});

// ---- The Live shortcut while a session runs ----

function renderDockWithShortcut(live: AssistantLiveController, activity: LiveActivity | null = null) {
  let shortcut: (() => void) | null = null;
  const useCommand = ((_id: string, handler: () => void) => {
    shortcut = handler;
  }) as unknown as NonNullable<Parameters<typeof AssistantDockPresentation>[0]["useCommand"]>;
  const view = render(
    <AssistantDockPresentation
      chat={{ approvals: [], decidingApprovalId: null, decideApproval: async () => undefined }}
      live={live}
      activity={activity}
      useCommand={useCommand}
    />,
  );
  return {
    ...view,
    press: () => act(() => (shortcut as (() => void) | null)?.()),
  };
}

test("the Live shortcut first moves focus to End and only a second press while End has focus ends Live", () => {
  let stops = 0;
  const live: AssistantLiveController = { ...openLive, stop: async () => void (stops += 1) };
  const dock = renderDockWithShortcut(live);
  const end = screen.getByRole("button", { name: "End Live" });
  dock.press();
  assert.equal(document.activeElement, end);
  assert.equal(stops, 0);

  // Focus moved away: the next press only brings focus back.
  act(() => end.blur());
  dock.press();
  assert.equal(stops, 0);
  assert.equal(document.activeElement, end);

  dock.press();
  assert.equal(stops, 1);
});

test("while the ribbon shows answer buttons and no End, the Live shortcut never ends Live", () => {
  let stops = 0;
  const live: AssistantLiveController = { ...openLive, stop: async () => void (stops += 1) };
  const dock = renderDockWithShortcut(live, {
    kind: "approval",
    id: "a1",
    title: "Run npm test?",
    chatTitle: "Fix login",
    voice: false,
    allow: () => undefined,
    deny: () => undefined,
  });
  assert.equal(screen.queryByRole("button", { name: "End Live" }), null);
  dock.press();
  dock.press();
  assert.equal(stops, 0);
});

// ---- Ending Live by voice ----

function playback(initial: { idle: boolean; bargeIns: number }) {
  const state = { ...initial };
  return { state, probe: { playbackState: () => ({ ...state }) } };
}

function EndingHarness({
  live,
  options,
}: {
  live: Parameters<typeof useLiveVoiceEnding>[0];
  options: Parameters<typeof useLiveVoiceEnding>[1];
}) {
  useLiveVoiceEnding(live, options);
  return null;
}

function endingFixture(maxWaitMs?: number, extra: { answerPending?: () => boolean } = {}) {
  const bus = new LiveSessionBus();
  const activity = new LiveActivityStore();
  const audio = playback({ idle: true, bargeIns: 0 });
  let stops = 0;
  const live = { active: true, stop: async () => void (stops += 1), ...audio.probe };
  const results: Array<Record<string, unknown>> = [];
  bus.setSession("s1", {
    toolResult: async (_session, _request, response) => {
      results.push(response);
      return true;
    },
    note: async () => true,
  });
  render(
    <EndingHarness
      live={live}
      options={{ bus, activity, goodbyeStartMs: 120, settleMs: 60, pollMs: 10, ...(maxWaitMs ? { maxWaitMs } : {}), ...extra }}
    />,
  );
  return { bus, activity, audio, results, stops: () => stops };
}

const tick = (ms = 0) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

test("saying an exact end phrase in any supported language ends Live", async () => {
  for (const phrase of ["Bye!", "Tschüss", "au revoir"]) {
    const fixture = endingFixture();
    fixture.bus.publishVoiceInput(phrase);
    await tick(40);
    assert.equal(fixture.stops(), 0, `${phrase}: Live's goodbye may still be on its way`);
    await tick(160);
    assert.equal(fixture.stops(), 1, phrase);
    cleanup();
  }
});

test("after the user says bye, Live's spoken goodbye that starts late still plays to the end", async () => {
  const fixture = endingFixture();
  fixture.bus.publishVoiceInput("bye");
  await tick(60);
  fixture.audio.state.idle = false; // the goodbye reply arrives
  await tick(300);
  assert.equal(fixture.stops(), 0, "still saying goodbye");
  fixture.audio.state.idle = true;
  await tick(150);
  assert.equal(fixture.stops(), 1);
});

test("an end phrase inside a longer sentence, or while an approval or confirmation shows, does not end Live", async () => {
  const fixture = endingFixture();
  fixture.bus.publishVoiceInput("bye the way, open settings");
  await tick();
  assert.equal(fixture.stops(), 0);

  fixture.activity.set("chat-approvals", {
    kind: "approval",
    id: "a1",
    title: "Run npm test?",
    chatTitle: "Fix login",
    voice: true,
    allow: () => undefined,
    deny: () => undefined,
  });
  fixture.bus.publishVoiceInput("bye");
  await tick(150);
  assert.equal(fixture.stops(), 0);

  fixture.activity.set("chat-approvals", { kind: "confirm", id: "c1", label: "Delete", confirm: () => undefined, cancel: () => undefined });
  fixture.bus.publishVoiceInput("bye");
  await tick(150);
  assert.equal(fixture.stops(), 0);

  fixture.activity.set("chat-approvals", null);
  fixture.bus.publishVoiceInput("bye");
  await tick(250);
  assert.equal(fixture.stops(), 1);
});

test("neither bye nor Live's end tool ends Live while any request waits on the user", async () => {
  let legacyApproval = true;
  const fixture = endingFixture(undefined, { answerPending: () => legacyApproval });
  fixture.bus.publishVoiceInput("bye");
  await tick(250);
  assert.equal(fixture.stops(), 0, "the dock's Computer Use approval is waiting");
  await fixture.bus.runToolRequest({ sessionId: "s1", requestId: "r1", name: "end_session", args: {} });
  assert.deepEqual(fixture.results[fixture.results.length - 1], {
    ok: false,
    error: { code: "answer_pending", message: "Answer the waiting request first." },
  });

  legacyApproval = false;
  fixture.activity.set("chat-approvals", { kind: "confirm", id: "c1", label: "Delete", confirm: () => undefined, cancel: () => undefined });
  await fixture.bus.runToolRequest({ sessionId: "s1", requestId: "r2", name: "end_session", args: {} });
  assert.equal(fixture.results[fixture.results.length - 1]?.ok, false);
  assert.equal(fixture.stops(), 0);

  // A request that appears while the goodbye plays also keeps Live running.
  fixture.activity.set("chat-approvals", null);
  fixture.audio.state.idle = false;
  const ending = fixture.bus.runToolRequest({ sessionId: "s1", requestId: "r3", name: "end_session", args: {} });
  await tick(30);
  fixture.activity.set("chat-approvals", { kind: "confirm", id: "c2", label: "Delete", confirm: () => undefined, cancel: () => undefined });
  fixture.audio.state.idle = true;
  await ending;
  assert.deepEqual(fixture.results[fixture.results.length - 1]?.error, {
    code: "answer_pending",
    message: "Answer the waiting request first.",
  });
  assert.equal(fixture.stops(), 0);
});

test("Live's end tool lets the goodbye finish playing, then ends the session", async () => {
  const fixture = endingFixture();
  fixture.audio.state.idle = false;
  void fixture.bus.runToolRequest({ sessionId: "s1", requestId: "r1", name: "end_session", args: {} });
  await tick(250);
  assert.equal(fixture.stops(), 0, "still saying goodbye");
  fixture.audio.state.idle = true;
  await tick(250);
  assert.equal(fixture.stops(), 1);
});

test("talking over the goodbye cancels the end, and a goodbye that never finishes is cut off at the limit", async () => {
  const fixture = endingFixture(400);
  fixture.audio.state.idle = false;
  void fixture.bus.runToolRequest({ sessionId: "s1", requestId: "r1", name: "end_session", args: {} });
  await tick(150);
  fixture.audio.state.bargeIns += 1; // barge-in flushed playback
  await tick(150);
  assert.equal(fixture.stops(), 0);
  assert.deepEqual(fixture.results[fixture.results.length - 1], { ok: false, error: { code: "cancelled", message: "The user kept talking." } });

  void fixture.bus.runToolRequest({ sessionId: "s1", requestId: "r2", name: "end_session", args: {} });
  await tick(250);
  assert.equal(fixture.stops(), 0);
  await tick(300);
  assert.equal(fixture.stops(), 1, "ended once the bounded wait ran out");
});

test("waiting for playback reports a cancelled wait without ending anything", async () => {
  const audio = playback({ idle: false, bargeIns: 0 });
  const abort = new AbortController();
  const waiting = waitForLivePlayback(audio.probe, abort.signal, { maxWaitMs: 1_000, pollMs: 10 });
  abort.abort();
  assert.equal(await waiting, "cancelled");
});
