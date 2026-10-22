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

const WORKSPACE: Workspace = {
  id: "ws-1",
  name: "app",
  folderPath: "/tmp/app",
  permission: "full",
  createdAt: 1,
  updatedAt: 1,
};
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

function Harness() {
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
            onRenameChat={() => undefined}
            onSend={async () => undefined}
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

  await act(async () => {
    finishTranscription("on Safari");
  });
  await waitFor(() => assert.equal(textbox.value, "Fix the bug on Safari in login"));
  assert.equal(textbox.readOnly, false);
});
