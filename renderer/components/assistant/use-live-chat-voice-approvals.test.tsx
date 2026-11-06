import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { installBotTestIpc } from "../../main/bots/test-dom";
import { chatsApi, type ApprovalPrompt } from "../../lib/ipc";
import { LiveActivityStore } from "../../lib/live-activity";
import { LiveChatApprovalsStore, LiveChatVoiceApprovals } from "../../lib/live-chat-approvals";
import { LiveOpenChatStore } from "../../lib/live-open-chat";
import { LiveSessionBus } from "../../lib/live-session-bus";
import { ChatApprovalCard } from "../chat-approval-card";
import { TooltipProvider } from "../ui";
import {
  useLiveApprovalVoiceHint,
  useLiveChatVoiceApprovals,
  usePublishLiveChatApprovals,
} from "./use-live-chat-voice-approvals";

afterEach(cleanup);

const runTests: ApprovalPrompt = {
  approvalId: "a1",
  toolCallId: "t1",
  toolName: "run_command",
  summary: "Run command: npm test",
  preview: { kind: "command", command: "npm test" },
};

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
}

test("approvals left in state from the previous chat are never published under the next chat", () => {
  const store = new LiveChatApprovalsStore();
  const decide = async () => undefined;
  function Pane({ chatId, approvals }: { chatId: string; approvals: readonly ApprovalPrompt[] }) {
    usePublishLiveChatApprovals(chatId, approvals, decide, store);
    return null;
  }
  const first = [runTests];
  const view = render(<Pane chatId="c1" approvals={first} />);
  assert.equal(store.get()?.chatId, "c1");
  assert.deepEqual(store.get()?.approvals.map((prompt) => prompt.approvalId), ["a1"]);

  view.rerender(<Pane chatId="c2" approvals={first} />);
  assert.equal(store.get()?.chatId, "c2");
  assert.deepEqual(store.get()?.approvals, [], "c1's approval is not c2's");

  view.rerender(<Pane chatId="c2" approvals={[{ ...runTests, approvalId: "b1" }]} />);
  assert.deepEqual(store.get()?.approvals.map((prompt) => prompt.approvalId), ["b1"]);

  view.unmount();
  assert.equal(store.get(), null);
});

/**
 * A chat pane in miniature: its card's buttons and Live's voice both call the
 * pane's decide, which sends the answer over `chat:approve` like the real pane.
 */
function mountPane(settings: Record<string, unknown> = {}) {
  const calls = installBotTestIpc({ "chat:approve": () => undefined });
  const bus = new LiveSessionBus();
  const openChat = new LiveOpenChatStore();
  const store = new LiveChatApprovalsStore();
  const controller = new LiveChatVoiceApprovals({ bus, openChat, approvals: store, activity: new LiveActivityStore() });
  bus.setSession("s1", { toolResult: async () => true, note: async () => true });
  openChat.publish(Symbol("pane"), { chatId: "c1", title: "Fix login", workspaceId: null, busy: true, streamId: "s" });

  function Pane() {
    useLiveChatVoiceApprovals(settings, controller);
    const [approvals, setApprovals] = React.useState<ApprovalPrompt[]>([runTests]);
    const decide = React.useCallback(async (prompt: ApprovalPrompt, decision: "allow" | "deny", options?: object) => {
      await chatsApi.approve(prompt.approvalId, decision, options);
      setApprovals((current) => current.filter((candidate) => candidate.approvalId !== prompt.approvalId));
    }, []);
    usePublishLiveChatApprovals("c1", approvals, decide, store);
    const pending = approvals[0];
    const liveVoice = useLiveApprovalVoiceHint(pending?.approvalId, controller);
    return pending ? (
      <ChatApprovalCard
        pending={pending}
        deciding={false}
        onDecide={(decision, options) => void decide(pending, decision, options)}
        liveVoice={liveVoice}
      />
    ) : null;
  }
  render(
    <TooltipProvider>
      <Pane />
    </TooltipProvider>,
  );
  const approveCalls = () => calls.filter((call) => call.channel === "chat:approve").map((call) => call.args);
  return { bus, approveCalls };
}

test("a spoken allow sends the same chat:approve as tapping Allow once", async () => {
  const tapped = mountPane();
  await settle();
  screen.getByText("Live is listening. Say “allow” or “deny”.");
  fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
  await settle();
  const byTap = tapped.approveCalls();
  cleanup();

  const spoken = mountPane();
  await settle();
  act(() => {
    spoken.bus.publishVoiceInput("permitir");
  });
  await settle();
  assert.deepEqual(spoken.approveCalls(), byTap);
  assert.deepEqual(byTap, [["a1", "allow", undefined]]);
  assert.ok(!screen.queryByRole("region"), "the card is answered");
});

test("with the switch off the card shows no voice hint and speech does nothing", async () => {
  const pane = mountPane({ aidenLiveVoiceApprovals: false });
  await settle();
  assert.ok(!screen.queryByText(/Say “allow” or “deny”/u));
  act(() => {
    pane.bus.publishVoiceInput("allow");
  });
  await settle();
  assert.deepEqual(pane.approveCalls(), []);
  screen.getByRole("region");
});
