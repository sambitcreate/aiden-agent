import assert from "node:assert/strict";
import test from "node:test";
import { DOMImplementation } from "@xmldom/xmldom";
import type {
  AssistantLiveRendererEvent,
  AssistantLiveSnapshot,
} from "../../shared/assistant-live.js";
import type { Chat, ComputerUseStatus } from "../../lib/types.js";
import {
  assistantLiveRuntimeErrorDetail,
  assistantLiveStartErrorDetail,
  PcmPlayer,
  reconcileAssistantLiveCaption,
  sealAssistantLiveCaption,
  type AssistantLiveController,
  type AssistantLiveDependencies,
  useAssistantLiveWithDependencies,
} from "./use-assistant-live.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

class FakeAudioNode {
  disconnected = false;
  connect<T>(destination: T): T {
    return destination;
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

class FakeTrack {
  stopped = false;
  stop(): void {
    this.stopped = true;
  }
}

class FakeWorklet extends FakeAudioNode {
  readonly port = {
    onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
  };
  emit(data: unknown): void {
    this.port.onmessage?.({ data } as MessageEvent<unknown>);
  }
}

class FakeCaptureContext {
  readonly destination = new FakeAudioNode();
  readonly source = new FakeAudioNode();
  readonly gain = Object.assign(new FakeAudioNode(), { gain: { value: 1 } });
  closed = false;
  resumed = false;
  createMediaStreamSource(): MediaStreamAudioSourceNode {
    return this.source as unknown as MediaStreamAudioSourceNode;
  }
  createGain(): GainNode {
    return this.gain as unknown as GainNode;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  async resume(): Promise<void> {
    this.resumed = true;
  }
}

class RecordingPlayer extends PcmPlayer {
  pauses = 0;
  resumes = 0;
  closes = 0;
  enqueues = 0;
  override enqueue(_pcm: Uint8Array): void {
    this.enqueues += 1;
  }
  override pauseAndFlush(): void {
    this.pauses += 1;
  }
  override resume(): void {
    this.resumes += 1;
  }
  override async close(): Promise<void> {
    this.closes += 1;
  }
}

interface HookFixture {
  controller(): AssistantLiveController;
  emit(event: AssistantLiveRendererEvent): void;
  startCalls(): number;
  stopCalls(): number;
  worklets: FakeWorklet[];
  contexts: FakeCaptureContext[];
  tracks: FakeTrack[];
  player: RecordingPlayer;
  computerUseChanges(): boolean[];
  refreshAvailability(): Promise<void>;
  unmount(): Promise<void>;
}

async function mountHook(
  overrides: Partial<AssistantLiveDependencies> = {},
): Promise<HookFixture> {
  const document = new DOMImplementation().createDocument(
    null,
    "html",
    null,
  ) as unknown as Document;
  const body = document.createElement("body");
  const container = document.createElement("div");
  body.appendChild(container);
  document.documentElement.appendChild(body);
  const elementPrototype = Object.getPrototypeOf(container) as HTMLElement &
    Record<string, unknown>;
  elementPrototype.addEventListener = () => undefined;
  elementPrototype.removeEventListener = () => undefined;
  Object.defineProperty(elementPrototype, "style", {
    configurable: true,
    get: () => ({}),
  });
  const documentPrototype = Object.getPrototypeOf(document) as Document;
  documentPrototype.addEventListener = () => undefined;
  documentPrototype.removeEventListener = () => undefined;
  Object.defineProperty(document, "body", { configurable: true, value: body });
  const windowValue = {
    document,
    event: undefined,
    HTMLIFrameElement: class HTMLIFrameElement {},
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  Object.defineProperty(document, "defaultView", {
    configurable: true,
    value: windowValue,
  });
  const keys = [
    "window",
    "document",
    "navigator",
    "Node",
    "Element",
    "HTMLElement",
  ] as const;
  const previous = new Map(
    keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const ElementConstructor = Object.getPrototypeOf(
    document.documentElement,
  ).constructor;
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: windowValue },
    document: { configurable: true, value: document },
    navigator: {
      configurable: true,
      value: { userAgent: "assistant-live-test" },
    },
    Node: { configurable: true, value: ElementConstructor },
    Element: { configurable: true, value: ElementConstructor },
    HTMLElement: { configurable: true, value: ElementConstructor },
  });

  let handler: (event: AssistantLiveRendererEvent) => void = () => undefined;
  let snapshot: AssistantLiveSnapshot = {
    available: true,
    reason: "available",
    model: "gemini-live-test",
    state: "idle",
  };
  let starts = 0;
  let stops = 0;
  const tracks: FakeTrack[] = [];
  const worklets: FakeWorklet[] = [];
  const contexts: FakeCaptureContext[] = [];
  const player = new RecordingPlayer();
  const computerUseChanges: boolean[] = [];
  let chatComputerUseEnabled = false;
  const readyComputerUseStatus: ComputerUseStatus = {
    enabled: true,
    beta: true,
    state: "ready",
    detail:
      "Accessibility and Screen Recording are available to Aiden Computer Use.",
    ready: true,
    available: true,
    retryable: false,
    canRequestPermissions: false,
    permissions: { accessibility: true, screenRecording: true },
  };
  const api = {
    status: async () => snapshot,
    start: async () => {
      starts += 1;
      snapshot = { ...snapshot, sessionId: `session-${starts}`, state: "open" };
      return snapshot;
    },
    stop: async () => {
      stops += 1;
      snapshot = { ...snapshot, sessionId: undefined, state: "idle" };
      return snapshot;
    },
    sendAudio: async () => true,
    onEvent: (next: (event: AssistantLiveRendererEvent) => void) => {
      handler = next;
      return () => {
        handler = () => undefined;
      };
    },
  };
  let dependencies: AssistantLiveDependencies = {
    geminiLive: true,
    api,
    askForMicrophone: async () => true,
    getMicrophoneStatus: async () => "granted",
    getUserMedia: async () => {
      const track = new FakeTrack();
      tracks.push(track);
      return { getTracks: () => [track] } as unknown as MediaStream;
    },
    createCaptureContext: () => {
      const context = new FakeCaptureContext();
      contexts.push(context);
      return context as unknown as AudioContext;
    },
    createWorklet: () => {
      const worklet = new FakeWorklet();
      worklets.push(worklet);
      return worklet as unknown as AudioWorkletNode;
    },
    loadWorklet: async () => undefined,
    createPlayer: () => player,
    computerUse: { status: async () => readyComputerUseStatus },
    chats: {
      get: async () => ({ computerUseEnabled: chatComputerUseEnabled }) as Chat,
      setComputerUse: async (_chatId, enabled) => {
        computerUseChanges.push(enabled);
        chatComputerUseEnabled = enabled;
        return { computerUseEnabled: enabled } as Chat;
      },
    },
    activeChatId: "assistant-chat",
    ...overrides,
  };
  let latest!: AssistantLiveController;
  function Harness() {
    latest = useAssistantLiveWithDependencies(dependencies);
    return <div />;
  }
  const { createRoot } = await import("react-dom/client");
  const { flushSync } = await import("react-dom");
  const root = createRoot(container);
  flushSync(() => root.render(<Harness />));
  await settle();
  flushSync(() => undefined);

  return {
    controller: () => latest,
    emit: (event) => flushSync(() => handler(event)),
    startCalls: () => starts,
    stopCalls: () => stops,
    worklets,
    contexts,
    tracks,
    player,
    computerUseChanges: () => [...computerUseChanges],
    refreshAvailability: async () => {
      dependencies = {
        ...dependencies,
        availabilityRefreshReady: false,
      };
      flushSync(() => root.render(<Harness />));
      await settle();
      dependencies = {
        ...dependencies,
        availabilityRefreshReady: true,
        availabilityRefreshToken:
          (dependencies.availabilityRefreshToken ?? 0) + 1,
      };
      flushSync(() => root.render(<Harness />));
      await settle();
      flushSync(() => undefined);
    },
    unmount: async () => {
      flushSync(() => root.unmount());
      await settle();
      for (const key of keys) {
        const descriptor = previous.get(key);
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("provider refresh rechecks Live availability without remounting or reconnecting", async () => {
  let hasGoogleCredential = false;
  let statusCalls = 0;
  let starts = 0;
  const status = async (): Promise<AssistantLiveSnapshot> => {
    statusCalls += 1;
    return hasGoogleCredential
      ? {
          available: true,
          reason: "available",
          model: "gemini-live-test",
          state: "idle",
        }
      : {
          available: false,
          reason: "missing_google_credential",
          state: "idle",
        };
  };
  const fixture = await mountHook({
    availabilityRefreshToken: 1,
    api: {
      status,
      start: async () => {
        starts += 1;
        return {
          available: true,
          reason: "available",
          model: "gemini-live-test",
          sessionId: "unexpected-session",
          state: "open",
        };
      },
      stop: status,
      sendAudio: async () => true,
      onEvent: () => () => undefined,
    },
  });
  assert.equal(fixture.controller().available, false);
  assert.match(
    fixture.controller().availabilityDetail,
    /Connect Google with an API key/u,
  );

  hasGoogleCredential = true;
  await fixture.refreshAvailability();

  assert.equal(statusCalls, 2);
  assert.equal(fixture.controller().available, true);
  assert.match(
    fixture.controller().availabilityDetail,
    /Approved model: gemini-live-test/u,
  );
  assert.equal(starts, 0, "a credential refresh must never start Live");
  assert.equal(fixture.controller().active, false);
  await fixture.unmount();
});

test("fixed provider-start diagnostics remain actionable without exposing raw detail", () => {
  const message =
    "Error invoking remote method: Google Live quota is unavailable for this API key or project. Check its usage tier and billing.";
  assert.equal(assistantLiveStartErrorDetail(new Error(message)), message);
  const networkMessage =
    "Error invoking remote method: Aiden could not establish a connection to Google Live. Check your network, VPN, or firewall and try again.";
  assert.equal(
    assistantLiveStartErrorDetail(new Error(networkMessage)),
    networkMessage,
  );
  assert.equal(
    assistantLiveStartErrorDetail(
      new Error("wss://private.example?key=SECRET provider internals"),
    ),
    "Live could not start. Nothing is capturing; try again when you’re ready.",
  );
});

test("runtime diagnostics preserve fixed actionable categories without raw detail", () => {
  assert.match(
    assistantLiveRuntimeErrorDetail("idle_timeout"),
    /stopped responding/iu,
  );
  assert.match(
    assistantLiveRuntimeErrorDetail("malformed_server_event"),
    /unsupported event/iu,
  );
  assert.equal(
    assistantLiveRuntimeErrorDetail("private-provider-secret"),
    "The Live session encountered a provider error.",
  );
});

test("an availability refresh begun during start cannot overwrite the opened session", async () => {
  const staleStatus = deferred<AssistantLiveSnapshot>();
  const opening = deferred<AssistantLiveSnapshot>();
  let statusCalls = 0;
  let current: AssistantLiveSnapshot = {
    available: true,
    reason: "available",
    model: "gemini-live-test",
    state: "idle",
  };
  const api: AssistantLiveDependencies["api"] = {
    status: async () => {
      statusCalls += 1;
      return statusCalls === 1 ? current : staleStatus.promise;
    },
    start: async () => {
      current = await opening.promise;
      return current;
    },
    stop: async () => {
      current = { ...current, sessionId: undefined, state: "idle" };
      return current;
    },
    sendAudio: async () => true,
    onEvent: () => () => undefined,
  };
  const fixture = await mountHook({ api });
  const starting = fixture.controller().start();
  await settle();
  await fixture.refreshAvailability();
  assert.equal(statusCalls, 2);

  opening.resolve({ ...current, sessionId: "fresh-session", state: "open" });
  await starting;
  await settle();
  assert.equal(fixture.controller().active, true);
  staleStatus.resolve({ ...current, sessionId: undefined, state: "idle" });
  await settle();
  assert.equal(
    fixture.controller().active,
    true,
    "the stale idle status must not hide Stop while main remains live",
  );
  await fixture.controller().stop();
  await fixture.unmount();
});

test("an availability refresh begun during stop cannot restore a stale open session", async () => {
  const staleOpenStatus = deferred<AssistantLiveSnapshot>();
  const stoppingMain = deferred<void>();
  let statusCalls = 0;
  let current: AssistantLiveSnapshot = {
    available: true,
    reason: "available",
    model: "gemini-live-test",
    state: "idle",
  };
  const api: AssistantLiveDependencies["api"] = {
    status: async () => {
      statusCalls += 1;
      return statusCalls === 2 ? staleOpenStatus.promise : current;
    },
    start: async () => {
      current = { ...current, sessionId: "closing-session", state: "open" };
      return current;
    },
    stop: async () => {
      await stoppingMain.promise;
      current = { ...current, sessionId: undefined, state: "idle" };
      return current;
    },
    sendAudio: async () => true,
    onEvent: () => () => undefined,
  };
  const fixture = await mountHook({ api });
  await fixture.controller().start();
  await settle();
  assert.equal(fixture.controller().active, true);

  const stopping = fixture.controller().stop();
  await settle();
  await fixture.refreshAvailability();
  assert.equal(statusCalls, 2);
  stoppingMain.resolve();
  await stopping;
  await settle();
  assert.equal(fixture.controller().active, false);

  staleOpenStatus.resolve({
    ...current,
    sessionId: "closing-session",
    state: "open",
  });
  await settle();
  assert.equal(
    fixture.controller().active,
    false,
    "a stale open status must not restore Live after Stop is confirmed",
  );
  await fixture.unmount();
});

test("Computer Use stays off until a deliberate per-chat change and reports global readiness", async () => {
  const fixture = await mountHook();
  assert.equal(fixture.controller().computerUseEnabled, false);
  assert.equal(fixture.controller().computerUseReady, true);
  assert.match(
    fixture.controller().computerUseDetail,
    /Accessibility and Screen Recording/u,
  );
  assert.deepEqual(fixture.computerUseChanges(), []);

  await fixture.controller().setComputerUse(true);
  await settle();
  assert.deepEqual(fixture.computerUseChanges(), [true]);
  assert.equal(fixture.controller().computerUseEnabled, true);
  await fixture.controller().setComputerUse(false);
  await settle();
  assert.deepEqual(fixture.computerUseChanges(), [true, false]);
  assert.equal(fixture.controller().computerUseEnabled, false);
  await fixture.unmount();
});

test("mounted disable becomes fail-closed while persistence is deferred", async () => {
  const write = deferred<Chat>();
  const enabledFixture = await mountHook({
    chats: {
      get: async () => ({ computerUseEnabled: true }) as Chat,
      setComputerUse: async (_chatId, enabled) => {
        assert.equal(enabled, false);
        return write.promise;
      },
    },
  });
  assert.equal(enabledFixture.controller().computerUseEnabled, true);
  const disabling = enabledFixture.controller().setComputerUse(false);
  await settle();
  assert.equal(enabledFixture.controller().computerUseEnabled, false);
  assert.equal(enabledFixture.controller().computerUseBusy, true);
  write.resolve({ computerUseEnabled: false } as Chat);
  await disabling;
  await enabledFixture.unmount();
});

test("mounted disable reconciles durable truth after a rejected setting write", async () => {
  const fixture = await mountHook({
    chats: {
      get: async () => ({ computerUseEnabled: true }) as Chat,
      setComputerUse: async () => {
        throw new Error("Could not save Computer Use.");
      },
    },
  });
  assert.equal(fixture.controller().computerUseEnabled, true);
  await fixture.controller().setComputerUse(false);
  await settle();
  assert.equal(fixture.controller().computerUseEnabled, true);
  assert.match(fixture.controller().computerUseError ?? "", /Could not save/u);
  await fixture.unmount();
});

test("Computer Use cannot be enabled when the global helper is unavailable", async () => {
  const unavailable: ComputerUseStatus = {
    enabled: false,
    beta: true,
    state: "disabled",
    detail:
      "Turn on the Computer Use beta to make it available in individual chats.",
    ready: false,
    available: false,
    retryable: false,
    canRequestPermissions: false,
    permissions: { accessibility: null, screenRecording: null },
  };
  const fixture = await mountHook({
    computerUse: { status: async () => unavailable },
  });
  assert.equal(fixture.controller().computerUseReady, false);
  assert.match(
    fixture.controller().computerUseDetail,
    /Turn on the Computer Use beta/u,
  );
  await fixture.controller().setComputerUse(true);
  assert.deepEqual(fixture.computerUseChanges(), []);
  await fixture.unmount();
});

test("mounted Live hook blocks setup and start during an ordinary Assistant collision", async () => {
  for (const reason of [
    "Finish or stop the current Aiden response before starting Live.",
    "Decide the pending automation approval before starting Live.",
  ]) {
    const fixture = await mountHook({ ordinaryBusyReason: reason });
    fixture.controller().setSetupOpen(true);
    await fixture.controller().start();
    await settle();
    assert.equal(fixture.controller().setupOpen, false);
    assert.equal(fixture.startCalls(), 0);
    assert.equal(fixture.controller().startBlockedReason, reason);
    await fixture.unmount();
  }
});

test("a gate-revocation terminal snapshot stops local media and leaves manual restart", async () => {
  const fixture = await mountHook();
  await fixture.controller().start();
  await settle();
  assert.equal(fixture.contexts[0]?.resumed, true);
  assert.equal(fixture.controller().microphoneActive, true);
  fixture.emit({
    type: "caption",
    sessionId: "session-1",
    direction: "output",
    text: "Session-only caption",
    final: true,
  });
  assert.equal(fixture.controller().captions.length, 1);
  fixture.emit({
    type: "snapshot",
    snapshot: {
      available: true,
      reason: "available",
      model: "gemini-live-test",
      sessionId: "session-1",
      state: "closed",
    },
  });
  await settle();
  assert.equal(fixture.controller().active, false);
  assert.equal(fixture.controller().visible, true);
  assert.equal(fixture.controller().reconnectRequired, false);
  assert.equal(fixture.controller().microphoneActive, false);
  assert.deepEqual(fixture.controller().captions, []);
  assert.equal(fixture.tracks[0]?.stopped, true);
  assert.equal(
    fixture.startCalls(),
    1,
    "a terminal event must never auto-restart Live",
  );
  await fixture.unmount();
});

test("successful Stop clears session-only captions after main confirms termination", async () => {
  const fixture = await mountHook();
  await fixture.controller().start();
  await settle();
  fixture.emit({
    type: "caption",
    sessionId: "session-1",
    direction: "input",
    text: "Do not retain me",
    final: true,
  });
  assert.equal(fixture.controller().captions.length, 1);
  await fixture.controller().stop();
  await settle();
  assert.deepEqual(fixture.controller().captions, []);
  await fixture.unmount();
});

test("enabled experimental Live stays visible but blocked for unavailable model and microphone permission", async () => {
  const unavailableFixture = await mountHook({
    api: {
      status: async () => ({
        available: false,
        reason: "missing_google_credential",
        state: "idle",
      }),
      start: async () => {
        throw new Error("must not start");
      },
      stop: async () => ({
        available: false,
        reason: "missing_google_credential",
        state: "idle",
      }),
      sendAudio: async () => false,
      onEvent: () => () => undefined,
    },
  });
  await settle();
  assert.equal(unavailableFixture.controller().visible, true);
  assert.equal(unavailableFixture.controller().available, false);
  assert.match(
    unavailableFixture.controller().startBlockedReason ?? "",
    /Connect Google/u,
  );
  unavailableFixture.controller().setSetupOpen(true);
  await unavailableFixture.controller().start();
  assert.equal(unavailableFixture.controller().setupOpen, false);
  await unavailableFixture.unmount();

  const deniedFixture = await mountHook({
    getMicrophoneStatus: async () => "denied",
  });
  assert.equal(deniedFixture.controller().microphonePermission, "denied");
  assert.equal(deniedFixture.controller().microphonePermissionReady, false);
  assert.match(
    deniedFixture.controller().startBlockedReason ?? "",
    /System Settings/u,
  );
  await deniedFixture.controller().start();
  assert.equal(deniedFixture.startCalls(), 0);
  await deniedFixture.unmount();
});

test("a busy setup close transition aborts pending microphone permission and stops main", async () => {
  const permission = deferred<boolean>();
  const fixture = await mountHook({
    askForMicrophone: () => permission.promise,
  });
  await settle();
  fixture.controller().setSetupOpen(true);
  const starting = fixture.controller().start();
  for (
    let attempt = 0;
    attempt < 3 && !fixture.controller().busy;
    attempt += 1
  ) {
    await settle();
  }
  assert.equal(fixture.controller().busy, true);
  fixture.controller().setSetupOpen(false);
  permission.resolve(true);
  await starting;
  await settle();
  assert.equal(fixture.stopCalls() >= 1, true);
  assert.equal(
    fixture.tracks.length,
    0,
    "cancelled permission must not proceed to getUserMedia",
  );
  assert.equal(fixture.controller().active, false);
  await fixture.unmount();
});

test("controlled resumption drops playback while preserving and resuming the microphone graph", async () => {
  const fixture = await mountHook();
  await fixture.controller().start();
  await settle();
  assert.equal(fixture.controller().microphoneActive, true);
  const resumeCountBeforeResumption = fixture.player.resumes;
  fixture.emit({
    type: "snapshot",
    snapshot: {
      available: true,
      reason: "available",
      model: "gemini-live-test",
      sessionId: "session-1",
      state: "resuming",
    },
  });
  assert.equal(fixture.player.pauses, 1);
  assert.equal(fixture.tracks[0]?.stopped, false);
  fixture.emit({
    type: "snapshot",
    snapshot: {
      available: true,
      reason: "available",
      model: "gemini-live-test",
      sessionId: "session-1",
      state: "open",
    },
  });
  assert.equal(fixture.player.resumes, resumeCountBeforeResumption + 1);
  assert.equal(fixture.controller().microphoneActive, true);
  await fixture.unmount();
});

test("a busy setup close transition aborts pending worklet setup and releases its microphone", async () => {
  const workletLoad = deferred<void>();
  const fixture = await mountHook({ loadWorklet: () => workletLoad.promise });
  fixture.controller().setSetupOpen(true);
  const starting = fixture.controller().start();
  await settle();
  assert.equal(fixture.tracks.length, 1);
  fixture.controller().setSetupOpen(false);
  workletLoad.resolve();
  await starting;
  await settle();
  assert.equal(fixture.tracks[0]?.stopped, true);
  assert.equal(fixture.controller().microphoneActive, false);
  assert.equal(fixture.stopCalls() >= 1, true);
  await fixture.unmount();
});

test("old audio rejection cannot tear down replacement media and reconnect never auto-starts", async () => {
  const oldSend = deferred<boolean>();
  let starts = 0;
  let sends = 0;
  let snapshot: AssistantLiveSnapshot = {
    available: true,
    reason: "available",
    model: "gemini-live-test",
    state: "idle",
  };
  let handler: (event: AssistantLiveRendererEvent) => void = () => undefined;
  const api: AssistantLiveDependencies["api"] = {
    status: async () => snapshot,
    start: async () => {
      starts += 1;
      snapshot = {
        ...snapshot,
        sessionId: `replacement-${starts}`,
        state: "open",
      };
      return snapshot;
    },
    stop: async () => {
      snapshot = { ...snapshot, sessionId: undefined, state: "idle" };
      return snapshot;
    },
    sendAudio: async () => {
      sends += 1;
      if (sends === 1) return oldSend.promise;
      return true;
    },
    onEvent: (next) => {
      handler = next;
      return () => {
        handler = () => undefined;
      };
    },
  };
  const fixture = await mountHook({ api });
  await fixture.controller().start();
  fixture.worklets[0]?.emit({ type: "pcm", data: new ArrayBuffer(2) });
  await settle();
  await fixture.controller().stop();
  await fixture.controller().start();
  const replacementTrack = fixture.tracks[1];
  oldSend.reject(new Error("old request rejected"));
  await settle();
  assert.equal(
    replacementTrack?.stopped,
    false,
    "old rejection cannot stop replacement capture",
  );
  handler({
    type: "reconnect_required",
    sessionId: "replacement-2",
    reason: "unexpected_disconnect",
  });
  await settle();
  assert.equal(starts, 2, "reconnect is explicit and must not call start");
  assert.equal(fixture.controller().reconnectRequired, true);
  assert.equal(fixture.controller().active, false);
  await fixture.unmount();
});

test("audio rejection stops capture and the provider session instead of claiming to listen", async () => {
  let snapshot: AssistantLiveSnapshot = {
    available: true,
    reason: "available",
    model: "gemini-live-test",
    state: "idle",
  };
  let stops = 0;
  const fixture = await mountHook({
    api: {
      status: async () => snapshot,
      start: async () => {
        snapshot = { ...snapshot, sessionId: "audio-failure", state: "open" };
        return snapshot;
      },
      stop: async () => {
        stops += 1;
        snapshot = { ...snapshot, sessionId: undefined, state: "idle" };
        return snapshot;
      },
      sendAudio: async () => false,
      onEvent: () => () => undefined,
    },
  });
  await fixture.controller().start();
  fixture.worklets[0]?.emit({ type: "pcm", data: new ArrayBuffer(640) });
  await settle();
  await settle();
  assert.equal(fixture.controller().microphoneActive, false);
  assert.equal(fixture.controller().active, false);
  assert.equal(fixture.tracks[0]?.stopped, true);
  assert.equal(stops, 1);
  assert.match(fixture.controller().error ?? "", /audio could not be sent/iu);
  await fixture.unmount();
});

test("microphone activity is measured locally, throttled, and reset on Stop", async () => {
  const fixture = await mountHook();
  await fixture.controller().start();
  const oldWorklet = fixture.worklets[0];
  const data = new ArrayBuffer(640);
  const view = new DataView(data);
  for (let offset = 0; offset < data.byteLength; offset += 2)
    view.setInt16(offset, 8_192, true);
  fixture.worklets[0]?.emit({ type: "pcm", data });
  await settle();
  assert.equal(fixture.controller().microphoneLevel > 0.7, true);
  await fixture.controller().stop();
  await settle();
  assert.equal(fixture.controller().microphoneLevel, 0);
  oldWorklet?.emit({ type: "pcm", data: data.slice(0) });
  await settle();
  assert.equal(
    fixture.controller().microphoneLevel,
    0,
    "stale post-teardown PCM cannot restore microphone activity",
  );
  await fixture.unmount();
});

test("local microphone activity keeps decaying while four audio sends are backpressured", async () => {
  let snapshot: AssistantLiveSnapshot = {
    available: true,
    reason: "available",
    model: "gemini-live-test",
    state: "idle",
  };
  const pendingSends: Array<ReturnType<typeof deferred<boolean>>> = [];
  const fixture = await mountHook({
    api: {
      status: async () => snapshot,
      start: async () => {
        snapshot = {
          ...snapshot,
          sessionId: "meter-backpressure",
          state: "open",
        };
        return snapshot;
      },
      stop: async () => {
        snapshot = { ...snapshot, sessionId: undefined, state: "idle" };
        return snapshot;
      },
      sendAudio: async () => {
        const pending = deferred<boolean>();
        pendingSends.push(pending);
        return pending.promise;
      },
      onEvent: () => () => undefined,
    },
  });
  await fixture.controller().start();
  const signal = new ArrayBuffer(640);
  const signalView = new DataView(signal);
  for (let offset = 0; offset < signal.byteLength; offset += 2)
    signalView.setInt16(offset, 8_192, true);
  for (let index = 0; index < 4; index += 1)
    fixture.worklets[0]?.emit({ type: "pcm", data: signal.slice(0) });
  await settle();
  const loudLevel = fixture.controller().microphoneLevel;
  assert.equal(pendingSends.length, 4);
  for (let index = 0; index < 4; index += 1)
    fixture.worklets[0]?.emit({ type: "pcm", data: new ArrayBuffer(640) });
  await settle();
  assert.equal(fixture.controller().microphoneLevel < loudLevel, true);
  for (const pending of pendingSends) pending.resolve(true);
  await fixture.unmount();
});

test("provider turn boundaries seal same-speaker transcript turns exactly once", async () => {
  const fixture = await mountHook();
  await fixture.controller().start();
  for (const text of ["Feel", "free to ask"]) {
    fixture.emit({
      type: "caption",
      sessionId: "session-1",
      direction: "output",
      text,
      final: true,
    });
  }
  assert.equal(fixture.controller().captions.length, 1);
  assert.equal(fixture.controller().captions[0]?.text, "Feel free to ask");
  assert.equal(fixture.controller().captions[0]?.sealed, false);
  fixture.emit({
    type: "turn",
    sessionId: "session-1",
    state: "turn_complete",
  });
  assert.equal(fixture.controller().captions[0]?.sealed, true);
  fixture.emit({
    type: "caption",
    sessionId: "session-1",
    direction: "output",
    text: "What else?",
    final: true,
  });
  assert.equal(fixture.controller().captions.length, 2);
  assert.equal(fixture.controller().captions[1]?.sealed, false);
  await fixture.unmount();
});

test("stale availability cannot restore an open session after audio-failure shutdown", async () => {
  const staleOpen = deferred<AssistantLiveSnapshot>();
  let statusCalls = 0;
  let snapshot: AssistantLiveSnapshot = {
    available: true,
    reason: "available",
    model: "gemini-live-test",
    state: "idle",
  };
  const fixture = await mountHook({
    api: {
      status: async () => {
        statusCalls += 1;
        return statusCalls === 2 ? staleOpen.promise : snapshot;
      },
      start: async () => {
        snapshot = { ...snapshot, sessionId: "audio-race", state: "open" };
        return snapshot;
      },
      stop: async () => {
        snapshot = { ...snapshot, sessionId: undefined, state: "idle" };
        return snapshot;
      },
      sendAudio: async () => false,
      onEvent: () => () => undefined,
    },
  });
  await fixture.controller().start();
  await fixture.refreshAvailability();
  assert.equal(statusCalls, 2);
  fixture.worklets[0]?.emit({ type: "pcm", data: new ArrayBuffer(640) });
  await settle();
  await settle();
  assert.equal(fixture.controller().active, false);
  staleOpen.resolve({
    ...snapshot,
    sessionId: "audio-race",
    state: "open",
  });
  await settle();
  assert.equal(
    fixture.controller().active,
    false,
    "a refresh started before audio rejection must not restore stale open state",
  );
  await fixture.unmount();
});

test("audio-failure stop rejection preserves a conservative open-session warning", async () => {
  let snapshot: AssistantLiveSnapshot = {
    available: true,
    reason: "available",
    model: "gemini-live-test",
    state: "idle",
  };
  const fixture = await mountHook({
    api: {
      status: async () => snapshot,
      start: async () => {
        snapshot = {
          ...snapshot,
          sessionId: "audio-stop-failure",
          state: "open",
        };
        return snapshot;
      },
      stop: async () => {
        throw new Error("ipc failed");
      },
      sendAudio: async () => false,
      onEvent: () => () => undefined,
    },
  });
  await fixture.controller().start();
  fixture.worklets[0]?.emit({ type: "pcm", data: new ArrayBuffer(640) });
  await settle();
  assert.equal(fixture.controller().active, true);
  assert.equal(fixture.controller().microphoneActive, false);
  assert.match(
    fixture.controller().error ?? "",
    /provider session may still be open.*Stop Live/iu,
  );
  await fixture.unmount();
});

test("deferred disconnect cleanup cannot close replacement playback after reconnect audio", async () => {
  const oldContextClose = deferred<void>();
  let contexts = 0;
  const fixture = await mountHook({
    createCaptureContext: () => {
      contexts += 1;
      const context = new FakeCaptureContext();
      if (contexts === 1) context.close = () => oldContextClose.promise;
      return context as unknown as AudioContext;
    },
  });
  await fixture.controller().start();
  fixture.emit({
    type: "reconnect_required",
    sessionId: "session-1",
    reason: "unexpected_disconnect",
  });
  await settle();
  await fixture.controller().start();
  fixture.emit({
    type: "audio",
    sessionId: "session-2",
    pcm: new Uint8Array([0, 0]),
    sampleRate: 24_000,
  });
  oldContextClose.resolve();
  await settle();
  assert.equal(
    fixture.player.closes,
    0,
    "stale cleanup must not close replacement playback",
  );
  assert.equal(
    fixture.player.enqueues,
    1,
    "replacement session audio remains admitted",
  );
  assert.equal(
    fixture.tracks[1]?.stopped,
    false,
    "replacement microphone remains active",
  );
  await fixture.unmount();
});

test("stop failure reconciles an open provider session and leaves a truthful retry state", async () => {
  let handler: (event: AssistantLiveRendererEvent) => void = () => undefined;
  let started = false;
  const open: AssistantLiveSnapshot = {
    available: true,
    reason: "available",
    model: "gemini-live-test",
    sessionId: "session-failure",
    state: "open",
  };
  const api: AssistantLiveDependencies["api"] = {
    status: async () =>
      started
        ? open
        : {
            available: true,
            reason: "available",
            model: "gemini-live-test",
            state: "idle",
          },
    start: async () => {
      started = true;
      return open;
    },
    stop: async () => {
      throw new Error("ipc failed");
    },
    sendAudio: async () => true,
    onEvent: (next) => {
      handler = next;
      return () => {
        handler = () => undefined;
      };
    },
  };
  void handler;
  const fixture = await mountHook({ api });
  await fixture.controller().start();
  await fixture.controller().stop();
  await settle();
  assert.equal(fixture.controller().active, true);
  assert.equal(fixture.controller().microphoneActive, false);
  assert.match(
    fixture.controller().error ?? "",
    /provider session may still be open.*Stop again/iu,
  );
  await fixture.unmount();
});

test("unmount during a pending start stops main and fences the stale start response", async () => {
  const pendingStart = deferred<AssistantLiveSnapshot>();
  let stops = 0;
  const api: AssistantLiveDependencies["api"] = {
    status: async () => ({
      available: true,
      reason: "available",
      model: "gemini-live-test",
      state: "idle",
    }),
    start: () => pendingStart.promise,
    stop: async () => {
      stops += 1;
      return {
        available: false,
        reason: "live_model_unverified",
        state: "idle",
      };
    },
    sendAudio: async () => true,
    onEvent: () => () => undefined,
  };
  const fixture = await mountHook({ api });
  const starting = fixture.controller().start();
  await settle();
  const unmounting = fixture.unmount();
  pendingStart.resolve({
    available: true,
    reason: "available",
    model: "gemini-live-test",
    sessionId: "late",
    state: "open",
  });
  await Promise.all([starting, unmounting]);
  assert.equal(
    stops >= 1,
    true,
    "cleanup stops main while the stale response stays inert",
  );
});

test("a stale start response cannot stop or replace a newer renderer session", async () => {
  const firstStart = deferred<AssistantLiveSnapshot>();
  let starts = 0;
  let stops = 0;
  let snapshot: AssistantLiveSnapshot = {
    available: true,
    reason: "available",
    model: "gemini-live-test",
    state: "idle",
  };
  const api: AssistantLiveDependencies["api"] = {
    status: async () => snapshot,
    start: async () => {
      starts += 1;
      if (starts === 1) return firstStart.promise;
      snapshot = { ...snapshot, sessionId: "new-session", state: "open" };
      return snapshot;
    },
    stop: async () => {
      stops += 1;
      snapshot = { ...snapshot, sessionId: undefined, state: "idle" };
      return snapshot;
    },
    sendAudio: async () => true,
    onEvent: () => () => undefined,
  };
  const fixture = await mountHook({ api });
  const stale = fixture.controller().start();
  await settle();
  await fixture.controller().cancelSetup();
  await settle();
  await fixture.controller().start();
  firstStart.resolve({
    available: true,
    reason: "available",
    model: "gemini-live-test",
    sessionId: "old-session",
    state: "open",
  });
  await stale;
  await settle();
  assert.equal(fixture.controller().active, true);
  assert.equal(stops, 1, "only the explicit cancellation stops main");
  assert.equal(
    fixture.tracks[0]?.stopped,
    false,
    "replacement media remains active",
  );
  await fixture.unmount();
});

test("caption reconciliation updates one interim utterance and finalizes its stable identity", () => {
  let id = 0;
  const event = (
    text: string,
    final: boolean,
  ): Extract<AssistantLiveRendererEvent, { type: "caption" }> => ({
    type: "caption",
    sessionId: "s",
    direction: "input",
    text,
    final,
  });
  let captions = reconcileAssistantLiveCaption(
    [],
    event("hel", false),
    () => ++id,
  );
  captions = reconcileAssistantLiveCaption(
    captions,
    event("hello", false),
    () => ++id,
  );
  captions = reconcileAssistantLiveCaption(
    captions,
    event("hello", true),
    () => ++id,
  );
  captions = reconcileAssistantLiveCaption(
    captions,
    event("world", true),
    () => ++id,
  );
  assert.deepEqual(captions, [
    {
      id: 1,
      direction: "input",
      text: "hello world",
      final: true,
      sealed: false,
    },
  ]);
  captions = sealAssistantLiveCaption(captions);
  captions = reconcileAssistantLiveCaption(
    captions,
    event("A separate turn", true),
    () => ++id,
  );
  assert.equal(captions.length, 2);
  assert.equal(captions[0]?.sealed, true);
  assert.equal(captions[1]?.text, "A separate turn");
});

test("caption turns preserve a long response beyond the former fragment cap", () => {
  let captions: AssistantLiveController["captions"] = [];
  let id = 0;
  for (let index = 0; index < 64; index += 1) {
    captions = reconcileAssistantLiveCaption(
      captions,
      {
        type: "caption",
        sessionId: "s",
        direction: "output",
        text: `word${index}`,
        final: true,
      },
      () => ++id,
    );
  }
  assert.equal(captions.length, 1);
  assert.match(captions[0]?.text ?? "", /^word0 word1/u);
  assert.match(captions[0]?.text ?? "", /word63$/u);
});

test("playback interruption invalidates a pending resume before a source can start", async () => {
  const resume = deferred<void>();
  let sources = 0;
  let starts = 0;
  const context = {
    state: "suspended",
    destination: {},
    resume: () => resume.promise,
    close: async () => undefined,
    createBuffer: () => ({ copyToChannel: () => undefined }),
    createBufferSource: () => {
      sources += 1;
      return {
        buffer: null,
        connect: () => undefined,
        disconnect: () => undefined,
        onended: null,
        start: () => {
          starts += 1;
        },
        stop: () => undefined,
      };
    },
  } as unknown as AudioContext;
  const player = new PcmPlayer(() => context);
  player.enqueue(new Uint8Array([0, 0]));
  player.pauseAndFlush();
  resume.resolve();
  await settle();
  assert.equal(sources, 0);
  assert.equal(starts, 0);
  await player.close();
});

test("playback interruption stops an already active source", async () => {
  let stops = 0;
  const context = {
    state: "running",
    destination: {},
    resume: async () => undefined,
    close: async () => undefined,
    createBuffer: () => ({ copyToChannel: () => undefined }),
    createBufferSource: () => ({
      buffer: null,
      connect: () => undefined,
      disconnect: () => undefined,
      onended: null,
      start: () => undefined,
      stop: () => {
        stops += 1;
      },
    }),
  } as unknown as AudioContext;
  const player = new PcmPlayer(() => context);
  player.enqueue(new Uint8Array([0, 0]));
  await settle();
  player.pauseAndFlush();
  assert.equal(stops, 1);
  await player.close();
});
