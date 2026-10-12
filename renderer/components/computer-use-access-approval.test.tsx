import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { installBotTestIpc } from "../main/bots/test-dom";
import { createBotTestQueryClient } from "../main/bots/test-providers";
import { ChatApprovalCard, type ChatApprovalDecisionOptions } from "./chat-approval-card";
import { ComputerUseContinueCallout } from "./computer-use-access-approval";
import type { ApprovalPrompt } from "../lib/ipc";
import type { ComputerUseStatus } from "../lib/types";

afterEach(cleanup);

function status(overrides: Partial<ComputerUseStatus> = {}): ComputerUseStatus {
  return {
    enabled: true,
    beta: true,
    state: "ready",
    detail: "Computer Use is ready.",
    ready: true,
    available: true,
    retryable: false,
    canRequestPermissions: false,
    permissions: { accessibility: true, screenRecording: true },
    ...overrides,
  };
}

const missingScreenRecording = status({
  state: "permission_required",
  detail: "Allow Screen Recording for Aiden in System Settings.",
  ready: false,
  canRequestPermissions: true,
  permissions: { accessibility: true, screenRecording: false },
});

const accessRequest: ApprovalPrompt = {
  approvalId: "cu-1",
  toolCallId: "call-1",
  toolName: "computer_use",
  summary: "Use your computer in this chat",
  details: { kind: "computer-use-access" } as ApprovalPrompt["details"],
  scopes: ["chat", "always"],
};

function mountCard({
  host,
  initial,
  afterRequest,
}: {
  host?: "local" | "remote";
  initial?: ComputerUseStatus;
  afterRequest?: ComputerUseStatus;
}) {
  const decisions: Array<{ decision: "allow" | "deny"; options?: ChatApprovalDecisionOptions }> = [];
  const calls = installBotTestIpc({
    "computerUse:status": () => initial ?? status(),
    "computerUse:requestPermissions": () => afterRequest ?? initial ?? status(),
  });
  render(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <ChatApprovalCard
        pending={accessRequest}
        deciding={false}
        onDecide={(decision, options) => decisions.push({ decision, options })}
        computerUseHost={host}
      />
    </QueryClientProvider>,
  );
  return { decisions, calls };
}

const button = (name: string | RegExp) => screen.getByRole("button", { name });

test("the access request offers this chat or every chat, never a one-off allow", async () => {
  mountCard({});
  await screen.findByText("Aiden wants to use your computer");
  await waitFor(() => assert.equal((button("Allow for this chat") as HTMLButtonElement).disabled, false));
  assert.ok(button("Deny"));
  assert.ok(button("Always allow"));
  assert.equal(screen.queryByRole("button", { name: /Allow once/u }), null);
  assert.equal(screen.queryByRole("list", { name: "macOS permissions" }), null);
});

test("each choice answers with the scope it names", async () => {
  const { decisions } = mountCard({});
  await waitFor(() => assert.equal((button("Allow for this chat") as HTMLButtonElement).disabled, false));
  fireEvent.click(button("Allow for this chat"));
  fireEvent.click(button("Always allow"));
  fireEvent.click(button("Deny"));
  assert.deepEqual(decisions, [
    { decision: "allow", options: { scope: "chat" } },
    { decision: "allow", options: { scope: "always" } },
    { decision: "deny", options: undefined },
  ]);
});

test("missing macOS permissions hold both allows until System Settings grants them", async () => {
  const { decisions, calls } = mountCard({ initial: missingScreenRecording, afterRequest: status() });
  const checklist = await screen.findByRole("list", { name: "macOS permissions" });
  const rows = within(checklist).getAllByRole("listitem").map((row) => row.textContent);
  assert.deepEqual(rows, ["AccessibilityAllowed", "Screen RecordingNot allowed"]);
  screen.getByText(/quit and reopen Aiden/u);

  const allowChat = button("Allow for this chat") as HTMLButtonElement;
  const allowAlways = button("Always allow") as HTMLButtonElement;
  assert.equal(allowChat.disabled, true);
  assert.equal(allowAlways.disabled, true);
  const reasonId = allowChat.getAttribute("aria-describedby")?.split(" ")[0];
  assert.ok(reasonId);
  assert.match(document.getElementById(reasonId)?.textContent ?? "", /Accessibility and Screen Recording/u);

  fireEvent.click(button("Deny"));
  assert.deepEqual(decisions, [{ decision: "deny", options: undefined }]);

  fireEvent.click(button("Open System Settings"));
  await waitFor(() => assert.equal((button("Allow for this chat") as HTMLButtonElement).disabled, false));
  assert.equal((button("Always allow") as HTMLButtonElement).disabled, false);
  assert.ok(calls.some((call) => call.channel === "computerUse:requestPermissions"));
  assert.equal(screen.queryByRole("list", { name: "macOS permissions" }), null);
});

test("without a permission prompt to offer, the checklist explains what is wrong instead", async () => {
  mountCard({
    initial: status({
      state: "unavailable",
      detail: "The signed Computer Use helper is missing.",
      ready: false,
      canRequestPermissions: false,
      permissions: { accessibility: null, screenRecording: null },
    }),
  });
  await screen.findByText("The signed Computer Use helper is missing.");
  assert.equal(screen.queryByRole("button", { name: "Open System Settings" }), null);
  assert.equal((button("Allow for this chat") as HTMLButtonElement).disabled, true);
});

test("a remote viewer leaves setup to the host Mac and never checks this Mac", async () => {
  const { calls, decisions } = mountCard({ host: "remote", initial: missingScreenRecording });
  screen.getByText("Finish any Computer Use setup on the host Mac.");
  assert.equal((button("Allow for this chat") as HTMLButtonElement).disabled, false);
  fireEvent.click(button("Always allow"));
  assert.deepEqual(decisions, [{ decision: "allow", options: { scope: "always" } }]);
  assert.equal(screen.queryByRole("list", { name: "macOS permissions" }), null);
  assert.equal(calls.some((call) => call.channel.startsWith("computerUse:")), false);
});

function mountCallout(initial: ComputerUseStatus, continueDisabledReason?: string) {
  const events: string[] = [];
  installBotTestIpc({ "computerUse:status": () => initial });
  render(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <ComputerUseContinueCallout
        onContinue={() => {
          events.push("continue");
        }}
        onDismiss={() => {
          events.push("dismiss");
        }}
        continueDisabledReason={continueDisabledReason}
      />
    </QueryClientProvider>,
  );
  return events;
}

test("once ready, the callout continues or dismisses the stopped task", async () => {
  const events = mountCallout(status());
  await screen.findByText("Continue where Aiden left off?");
  fireEvent.click(button("Continue"));
  await waitFor(() => assert.deepEqual(events, ["continue"]));
  fireEvent.click(button("Dismiss"));
  await waitFor(() => assert.deepEqual(events, ["continue", "dismiss"]));
});

test("while permissions are still missing, the callout shows the checklist and only Dismiss", async () => {
  const events = mountCallout(missingScreenRecording);
  await screen.findByRole("list", { name: "macOS permissions" });
  assert.equal(screen.queryByRole("button", { name: "Continue" }), null);
  assert.ok(button("Open System Settings"));
  fireEvent.click(button("Dismiss"));
  await waitFor(() => assert.deepEqual(events, ["dismiss"]));
});

test("a chat that cannot send keeps Continue disabled and says why", async () => {
  mountCallout(status(), "Choose a model before sending.");
  await screen.findByText("Choose a model before sending.");
  const continueButton = button("Continue") as HTMLButtonElement;
  assert.equal(continueButton.disabled, true);
  const describedBy = continueButton.getAttribute("aria-describedby");
  assert.ok(describedBy);
  assert.equal(document.getElementById(describedBy)?.textContent, "Choose a model before sending.");
});
