// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { emitBotTestNotification, installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Composer } from "./composer";
import { TooltipProvider } from "./ui";
import { CommandSystemProvider } from "../lib/command-system";
import type { Chat, Workspace } from "../lib/types";

// On-device dictation with a model that keeps up shows the words in the draft
// as the user speaks, where the dictation will land, then swaps in the final
// text once.

let queryClient: QueryClient;
let finishTranscription: (text: string) => void = () => {};
let sent: string[] = [];
let forks: string[] = [];

const WORKSPACE: Workspace = {
  id: "ws-1",
  name: "app",
  folderPath: "/tmp/app",
  permission: "full",
  createdAt: 1,
  updatedAt: 1,
};
const ANSWERED = {
  id: "answered-dictation", title: "Release", createdAt: 1, updatedAt: 2,
  messages: [
    { id: "u1", role: "user", content: "Plan the release", createdAt: 1 },
    { id: "a1", role: "assistant", content: "Here is a plan.", createdAt: 2 },
  ],
} as Chat;
const DRAFT = { id: "draft-dictation", title: "New chat", messages: [], createdAt: 1, updatedAt: 1 } as unknown as Chat;

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

let calls: ReturnType<typeof installBotTestIpc> = [];

beforeEach(() => {
  localStorage.clear();
  sent = [];
  forks = [];
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
    "voice:transcribeLocal": () =>
      new Promise<string>((resolve) => {
        finishTranscription = resolve;
      }),
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
  queryClient.clear();
});

function Harness({ sessionChat = DRAFT }: { sessionChat?: Chat }) {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <CommandSystemProvider>
          <Composer
            ready
            hasMessages={sessionChat.messages.length > 0}
            chatId={sessionChat.id}
            sessionChat={sessionChat}
            workspace={WORKSPACE}
            onRenameChat={() => undefined}
            onSend={async (text) => {
              sent.push(text);
            }}
            onForkChat={async (messageId) => { forks.push(messageId); }}
            onStop={() => undefined}
            isGenerating={false}
          />
        </CommandSystemProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

test("live dictation words appear in the draft at the caret and the final text replaces them", async () => {
  render(<Harness />);
  const textbox = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
  fireEvent.change(textbox, { target: { value: "Fix the bug in login" } });
  // The caret sits after "Fix the bug", so dictation lands there.
  textbox.setSelectionRange(11, 11);
  fireEvent.select(textbox);

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Start voice input" }));
  });
  await screen.findByRole("button", { name: "Stop recording" });
  await waitFor(() => assert.ok(calls.some((call) => call.channel === "voice:localLiveStart")));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  act(() => emitBotTestNotification("voice:stream-text", { sessionId: "live-1", committed: "on", tentative: "safari" }));
  await waitFor(() => assert.equal(textbox.value, "Fix the bug on safari in login"));
  assert.equal(textbox.readOnly, true, "the live words are not editable while they may still change");

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
  });
  // Stopping keeps the last live words until the final decode returns.
  await waitFor(() => assert.ok(calls.some((call) => call.channel === "voice:transcribeLocal")));
  assert.equal(textbox.readOnly, true);
  assert.equal(textbox.value, "Fix the bug on safari in login");

  // What shows is not yet the draft, so neither Enter nor Send sends it.
  assert.equal((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled, true);
  await act(async () => {
    fireEvent.keyDown(textbox, { key: "Enter" });
  });
  assert.deepEqual(sent, []);
  assert.equal(textbox.value, "Fix the bug on safari in login");

  await act(async () => {
    finishTranscription("on Safari");
  });
  await waitFor(() => assert.equal(textbox.value, "Fix the bug on Safari in login"));
  assert.equal(textbox.readOnly, false);

  await act(async () => {
    fireEvent.keyDown(textbox, { key: "Enter" });
  });
  await waitFor(() => assert.deepEqual(sent, ["Fix the bug on Safari in login"]));
});

test("↑ keeps live dictation in the current chat until its final transcript can be sent", async () => {
  render(<Harness sessionChat={ANSWERED} />);
  const textbox = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start voice input" })); });
  await waitFor(() => assert.ok(calls.some((call) => call.channel === "voice:localLiveStart")));
  act(() => emitBotTestNotification("voice:stream-text", { sessionId: "live-1", committed: "Keep these", tentative: "words" }));
  await waitFor(() => assert.equal(textbox.value, "Keep these words"));
  textbox.focus();
  fireEvent.keyDown(textbox, { key: "ArrowUp" });
  assert.deepEqual(forks, [], "a visible dictated draft must not navigate to a fork");
  assert.equal(textbox.value, "Keep these words");
  assert.ok(screen.getByRole("button", { name: "Stop recording" }), "capture stays active");

  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Stop recording" })); });
  await waitFor(() => assert.ok(calls.some((call) => call.channel === "voice:transcribeLocal")));
  fireEvent.keyDown(textbox, { key: "ArrowUp" });
  assert.deepEqual(forks, [], "the pending final decode still belongs to this chat");
  await act(async () => finishTranscription("Keep these words."));
  await waitFor(() => assert.equal(textbox.value, "Keep these words."));
  fireEvent.keyDown(textbox, { key: "ArrowUp" });
  assert.deepEqual(forks, [], "finalized text is still a draft");
  fireEvent.keyDown(textbox, { key: "Enter" });
  await waitFor(() => assert.deepEqual(sent, ["Keep these words."]));
});

test("↑ cannot abandon capture before any live words arrive, and works again after an empty decode", async () => {
  render(<Harness sessionChat={ANSWERED} />);
  const textbox = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start voice input" })); });
  await screen.findByRole("button", { name: "Stop recording" });
  fireEvent.keyDown(textbox, { key: "ArrowUp" });
  assert.deepEqual(forks, [], "an empty preview does not mean there is no recording to lose");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Stop recording" })); });
  await waitFor(() => assert.ok(calls.some((call) => call.channel === "voice:transcribeLocal")));
  fireEvent.keyDown(textbox, { key: "ArrowUp" });
  assert.deepEqual(forks, [], "an empty box still waits for its final decode");
  await act(async () => finishTranscription(""));
  await waitFor(() => assert.equal((screen.getByRole("button", { name: "Start voice input" }) as HTMLButtonElement).disabled, false));
  fireEvent.keyDown(textbox, { key: "ArrowUp" });
  assert.deepEqual(forks, ["u1"], "a settled empty box can edit the last prompt again");
});
