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
import { useLiveVoiceEnding, waitForLivePlayback } from "./live-ribbon-session";
import type { AidenLiveMarkState } from "./aiden-live-mark";
import type { AidenLivePreferencesPatch } from "./use-aiden-live-preferences";
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
  const approval = (voice: boolean): LiveActivity => ({
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

  renderRibbon({ activity: approval(false) });
  assert.equal(screen.queryByText("Say “allow” or “deny”"), null);
  assert.deepEqual(buttonNames(), ["Deny", "Allow"]);
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

// ---- Ending Live by voice ----

function playback(initial: { idle: boolean; flushes: number }) {
  const state = { ...initial };
  return { state, probe: { playbackState: () => ({ ...state }) } };
}

function EndingHarness({
  live,
  bus,
  activity,
  maxWaitMs,
}: {
  live: Parameters<typeof useLiveVoiceEnding>[0];
  bus: LiveSessionBus;
  activity: LiveActivityStore;
  maxWaitMs?: number;
}) {
  useLiveVoiceEnding(live, { bus, activity, ...(maxWaitMs ? { maxWaitMs } : {}) });
  return null;
}

function endingFixture(maxWaitMs?: number) {
  const bus = new LiveSessionBus();
  const activity = new LiveActivityStore();
  const audio = playback({ idle: true, flushes: 0 });
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
  render(<EndingHarness live={live} bus={bus} activity={activity} maxWaitMs={maxWaitMs} />);
  return { bus, activity, audio, results, stops: () => stops };
}

const tick = (ms = 0) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

test("saying an exact end phrase in any supported language ends Live", async () => {
  for (const phrase of ["Bye!", "Tschüss", "au revoir"]) {
    const fixture = endingFixture();
    fixture.bus.publishVoiceInput(phrase);
    await tick();
    assert.equal(fixture.stops(), 1, phrase);
    cleanup();
  }
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
  await tick();
  assert.equal(fixture.stops(), 1);
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
  fixture.audio.state.flushes += 1; // barge-in flushed playback
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
  const audio = playback({ idle: false, flushes: 0 });
  const abort = new AbortController();
  const waiting = waitForLivePlayback(audio.probe, abort.signal, 1_000, 10);
  abort.abort();
  assert.equal(await waiting, "cancelled");
});
