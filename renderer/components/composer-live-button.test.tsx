// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Composer } from "./composer";
import { TooltipProvider } from "./ui";
import { CommandSystemProvider } from "../lib/command-system";
import { LIVE_LAUNCH_IDLE, liveLauncher, type LiveLaunchState } from "../lib/live-launcher";
import { LIVE_PRESS_GUARD_MS, LIVE_SWAP_DELAY_MS } from "./composer-live-button";
import { AssistantDockPresentation } from "./assistant/assistant-dock";
import { idleLiveController } from "./assistant/assistant-live-test-fixture";
import type { AssistantLiveController } from "./assistant/use-assistant-live";
import type { Chat, Workspace } from "../lib/types";

// With an empty draft, the button in Send's place starts Aiden Live; typing,
// attaching, a running turn or dictation keep Send (or Stop).

const WORKSPACE: Workspace = {
  id: "ws-1",
  name: "app",
  folderPath: "/tmp/app",
  permission: "full",
  createdAt: 1,
  updatedAt: 1,
};
const DRAFT = { id: "draft-live", title: "New chat", messages: [], createdAt: 1, updatedAt: 1 } as unknown as Chat;
const READY: LiveLaunchState = { offered: true, sessionActive: false, needsSetup: false };

class FakeAudioWorkletNode {
  readonly port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage: (message: { type?: string }) => {
      if (message.type !== "flush") return;
      queueMicrotask(() => {
        this.port.onmessage?.({ data: new Float32Array(1_600).fill(0.25) });
        this.port.onmessage?.({ data: { type: "flushed" } });
      });
    },
  };
  connect<T>(node: T): T {
    return node;
  }
  disconnect() {}
}

class FakeAudioContext {
  sampleRate = 16_000;
  destination = {};
  audioWorklet = { addModule: async () => {} };
  createGain() {
    return { gain: { value: 1 }, connect: <T,>(node: T) => node, disconnect() {} };
  }
  createMediaStreamSource() {
    return { connect: <T,>(node: T) => node, disconnect() {} };
  }
  async resume() {}
  async close() {}
}

let queryClient: QueryClient;
let calls: ReturnType<typeof installBotTestIpc> = [];
let sent: string[] = [];
let launches = 0;

function offerLive(state: LiveLaunchState = READY) {
  act(() => liveLauncher.publish(state, () => { launches += 1; }));
}

const wait = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

beforeEach(() => {
  localStorage.clear();
  sent = [];
  launches = 0;
  calls = installBotTestIpc({
    "settings:get": () => null,
    "shortcut:get": () => null,
    "app:renderer-ready": () => null,
    "voice:resolveProvider": () => ({ kind: "ready", provider: "local", modelId: "parakeet-v3-metal", automatic: true }),
    "localVoice:warm": () => undefined,
    "voice:localLiveStart": () => ({ sessionId: "live-1" }),
    "voice:localLivePush": () => undefined,
    "voice:localLiveStop": () => undefined,
    "voice:transcribeLocalCancel": () => undefined,
    "voice:transcribeLocal": () => "kept words",
  });
  const globals = globalThis as Record<string, unknown>;
  globals.AudioContext = FakeAudioContext;
  globals.AudioWorkletNode = FakeAudioWorkletNode;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
  });
  (window as unknown as { aidenAPI: Record<string, unknown> }).aidenAPI.systemPreferences = {
    getMediaAccessStatus: async () => "granted",
    askForMediaAccess: async () => true,
  };
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
  });
});

afterEach(() => {
  cleanup();
  liveLauncher.publish(LIVE_LAUNCH_IDLE, null);
  queryClient.clear();
});

function Harness({ offer = true, isGenerating = false }: { offer?: boolean; isGenerating?: boolean }) {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <CommandSystemProvider>
          <Composer
            ready
            hasMessages={false}
            chatId={DRAFT.id}
            sessionChat={DRAFT}
            workspace={WORKSPACE}
            offerLive={offer}
            onRenameChat={() => undefined}
            onSend={async (text) => {
              sent.push(text);
            }}
            onStop={() => undefined}
            isGenerating={isGenerating}
          />
        </CommandSystemProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

const liveButton = () => screen.queryByRole("button", { name: "Start Aiden Live" });
const sendButton = () => screen.queryByRole("button", { name: "Send message" });

test("an empty draft offers Live in Send's place; typing turns it back into Send at once", async () => {
  offerLive();
  render(<Harness />);
  const textbox = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
  await waitFor(() => assert.ok(liveButton()), { timeout: LIVE_SWAP_DELAY_MS * 4 });
  assert.equal(sendButton(), null, "Live takes Send's place rather than sitting beside it");

  // Enter on an empty box never starts a voice session.
  await wait(LIVE_PRESS_GUARD_MS + 50);
  fireEvent.keyDown(textbox, { key: "Enter" });
  assert.equal(launches, 0);

  fireEvent.change(textbox, { target: { value: "hi" } });
  assert.equal(liveButton(), null);
  assert.equal((sendButton() as HTMLButtonElement).disabled, false);

  // Spaces alone are still an empty draft, but Live waits before coming back.
  fireEvent.change(textbox, { target: { value: "   " } });
  assert.ok(sendButton(), "clearing the draft keeps Send under the pointer for a moment");
  await waitFor(() => assert.ok(liveButton()), { timeout: LIVE_SWAP_DELAY_MS * 4 });

  // A press that lands right as the button turns into Live was meant for Send.
  fireEvent.click(liveButton()!);
  assert.equal(launches, 0);
  await wait(LIVE_PRESS_GUARD_MS + 50);
  fireEvent.click(liveButton()!);
  assert.equal(launches, 1);
  assert.deepEqual(sent, []);
});

test("first use names the setup step", async () => {
  offerLive({ ...READY, needsSetup: true });
  render(<Harness />);
  const button = await screen.findByRole("button", { name: "Set up Aiden Live" }, { timeout: LIVE_SWAP_DELAY_MS * 4 });
  assert.equal(button.getAttribute("aria-haspopup"), "dialog");
});

test("Send stays when Live is not offered, the chat can't use it, or a session is already on", async () => {
  for (const [name, state, offer] of [
    ["Live off or hidden in Settings", { ...READY, offered: false }, true],
    ["a Bot, remote or design chat", READY, false],
    ["a Live session already running", { ...READY, sessionActive: true }, true],
  ] as const) {
    offerLive(state);
    const view = render(<Harness offer={offer} />);
    await screen.findByRole("textbox");
    await wait(LIVE_SWAP_DELAY_MS + 100);
    assert.equal(liveButton(), null, name);
    assert.equal((sendButton() as HTMLButtonElement).disabled, true, name);
    view.unmount();
  }
});

test("a running turn keeps Stop in that place, never Live", async () => {
  offerLive();
  render(<Harness isGenerating />);
  await screen.findByRole("textbox");
  await wait(LIVE_SWAP_DELAY_MS + 100);
  assert.equal(liveButton(), null);
  assert.ok(screen.getByRole("button", { name: "Stop generating" }));
});

test("dictation and Live never listen at once", async () => {
  offerLive();
  render(<Harness />);
  await screen.findByRole("textbox");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Start voice input" }));
  });
  await screen.findByRole("button", { name: "Stop recording" });
  await wait(LIVE_SWAP_DELAY_MS + 100);
  assert.equal(liveButton(), null, "a recording keeps Send in place");

  // Starting Live from any entry point finishes the recording and keeps its words.
  await act(async () => liveLauncher.prepareStart());
  await waitFor(() => assert.ok(calls.some((call) => call.channel === "voice:transcribeLocal")));
  await waitFor(() => assert.equal((screen.getByRole("textbox") as HTMLTextAreaElement).value, "kept words"));

  // While Live has the microphone, dictation can't start.
  offerLive({ ...READY, sessionActive: true });
  assert.equal((screen.getByRole("button", { name: "Start voice input" }) as HTMLButtonElement).disabled, true);
});

function DockHarness({
  live,
  hostSupported = true,
  buttonVisible = true,
}: {
  live: AssistantLiveController;
  hostSupported?: boolean;
  buttonVisible?: boolean;
}) {
  return (
    <TooltipProvider>
      <AssistantDockPresentation
        chat={{ approvals: [], decidingApprovalId: null, decideApproval: async () => undefined }}
        live={live}
        hostSupported={hostSupported}
        buttonVisible={buttonVisible}
        useCommand={() => undefined}
      />
    </TooltipProvider>
  );
}

test("the dock offers Live to the composer only where it can start, and a press opens setup first", async () => {
  let setupOpened = 0;
  let started = 0;
  const live: AssistantLiveController = {
    ...idleLiveController,
    setSetupOpen: (open: boolean) => { if (open) setupOpened += 1; },
    start: async () => { started += 1; },
  };

  const hidden = render(<DockHarness live={live} buttonVisible={false} />);
  assert.equal(liveLauncher.get().offered, false, "the Settings switch off keeps plain Send");
  hidden.unmount();

  const unsupported = render(<DockHarness live={live} hostSupported={false} />);
  assert.equal(liveLauncher.get().offered, false, "no Live button where Live can't start");
  unsupported.unmount();

  render(<DockHarness live={live} />);
  assert.deepEqual(liveLauncher.get(), { offered: true, sessionActive: false, needsSetup: true });
  let dictationStopped = 0;
  const release = liveLauncher.onBeforeStart(() => { dictationStopped += 1; });
  act(() => { liveLauncher.launch(); });
  release();
  assert.equal(setupOpened, 1, "the first press opens setup rather than starting");
  assert.equal(started, 0);
  assert.equal(dictationStopped, 1, "dictation lets go of the microphone first");
});
