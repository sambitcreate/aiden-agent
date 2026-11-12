// The workspace repeat-approval nudge: after the same kind of action is allowed
// three times in a workspace in Ask, its card offers Auto, and the switch is an
// ordinary settings save.

import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { installBotTestIpc } from "../main/bots/test-dom";
import { createBotTestQueryClient } from "../main/bots/test-providers";
import { ChatApprovalCard } from "../components/chat-approval-card";
import type { ApprovalPrompt } from "./ipc";
import type { ApprovalWorkspaceFields } from "../shared/approval-mode";
import { noteWorkspaceAllow, resetWorkspaceAllows, useWorkspaceRepeatNudge } from "./switch-to-auto";

afterEach(cleanup);
beforeEach(resetWorkspaceAllows);

const USABLE = [{ id: "openai", models: ["fast"], hasKey: true, needsKey: true }];
const PROMPT: ApprovalPrompt = { approvalId: "a-1", toolCallId: "c-1", toolName: "gmail_send_email", summary: "Send the update." } as ApprovalPrompt;
const WORKSPACE = { id: "w-1", permission: "ask" } satisfies ApprovalWorkspaceFields & { id: string };

function Card({ workspace, pending }: { workspace: ApprovalWorkspaceFields & { id: string }; pending: ApprovalPrompt }) {
  return <ChatApprovalCard pending={pending} deciding={false} onDecide={() => {}} {...useWorkspaceRepeatNudge(workspace, pending)} />;
}

async function mount(options: { settings?: unknown; workspace?: ApprovalWorkspaceFields & { id: string }; pending?: ApprovalPrompt } = {}) {
  const saved: unknown[] = [];
  installBotTestIpc({
    "settings:get": () => options.settings ?? { approvalMode: "ask" },
    "settings:set": (patch) => { saved.push(patch); return { approvalMode: "auto" }; },
    "providers:list": () => USABLE,
  });
  render(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <Card workspace={options.workspace ?? WORKSPACE} pending={options.pending ?? PROMPT} />
    </QueryClientProvider>,
  );
  // Settings and providers land before anything is checked.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  return saved;
}

const offer = () => screen.queryByRole("button", { name: "Switch to Auto" });
const allow = (times: number, workspaceId = "w-1", toolName = PROMPT.toolName) => {
  for (let index = 0; index < times; index += 1) noteWorkspaceAllow(workspaceId, toolName);
};

test("the third allow of the same action in a workspace offers Auto, and choosing it saves the Mac's mode", async () => {
  allow(3);
  const saved = await mount();
  const card = screen.getByRole("region");
  assert.ok(within(card).getByText("You’ve allowed this 3 times since Aiden opened."));
  await act(async () => fireEvent.click(offer()!));
  assert.deepEqual(saved, [{ approvalMode: "auto" }]);
  assert.equal(offer(), null, "once in Auto the offer goes");
});

test("two allows, another workspace's allows or another action's allows offer nothing yet", async () => {
  allow(2);
  allow(5, "w-2");
  allow(5, "w-1", "slack_post_message");
  await mount();
  assert.equal(offer(), null);
  assert.equal(screen.queryByText(/since Aiden opened/u), null);
});

test("no offer in Auto or Never ask, for a workspace with its own mode or Chat only, or on a card Auto would not spare", async () => {
  allow(3);
  const cases: Array<[string, Parameters<typeof mount>[0]]> = [
    ["the Mac is in Auto", { settings: { approvalMode: "auto" } }],
    ["the Mac is in Never ask", { settings: { approvalMode: "never" } }],
    ["the workspace keeps its own Ask", { workspace: { ...WORKSPACE, approvalMode: "ask" } }],
    ["a legacy Full workspace", { workspace: { id: "w-1", permission: "full" } }],
    ["Chat only", { workspace: { id: "w-1", permission: "none" } }],
    ["a paired host's card", { pending: { ...PROMPT, source: "remote" } }],
    ["a command", { pending: { ...PROMPT, preview: { kind: "command", command: "ls" } } as ApprovalPrompt }],
  ];
  for (const [name, options] of cases) {
    await mount(options);
    assert.equal(offer(), null, name);
    cleanup();
  }
});
