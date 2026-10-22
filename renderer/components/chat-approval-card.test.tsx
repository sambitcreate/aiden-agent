import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ChatApprovalCard, type ChatApprovalDecisionOptions } from "./chat-approval-card";
import { TooltipProvider } from "./ui";
import type { ApprovalPrompt } from "../lib/ipc";
import { toolApprovalPreview } from "../shared/tool-approval-preview";

afterEach(cleanup);

function mount(pending: Partial<ApprovalPrompt> & Pick<ApprovalPrompt, "toolName" | "summary">) {
  const decisions: Array<[string, ChatApprovalDecisionOptions | undefined]> = [];
  render(
    <TooltipProvider>
      <ChatApprovalCard
        pending={{ approvalId: "approval-1", toolCallId: "call-1", ...pending }}
        deciding={false}
        onDecide={(decision, options) => decisions.push([decision, options])}
      />
    </TooltipProvider>,
  );
  return { card: screen.getByRole("region"), decisions };
}

test("a command approval asks a plain question and shows the exact command", () => {
  const command = "rm -rf dist && npm ci";
  const { card, decisions } = mount({
    toolName: "run_command",
    summary: `Run command: ${command}`,
    preview: toolApprovalPreview("run_command", { command }),
    scopes: ["once", "chat", "always"],
  });

  assert.equal(screen.getByRole("region", { name: "Run this command?" }), card);
  assert.match(card.querySelector("#approval-summary-approval-1")?.textContent ?? "", /rm -rf dist && npm ci$/u);
  assert.deepEqual(
    within(card).getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent),
    ["Copy command", "Deny", "Allow once", "More ways to allow"],
  );

  fireEvent.click(within(card).getByRole("button", { name: "Allow once" }));
  fireEvent.click(within(card).getByRole("button", { name: "Deny" }));
  assert.deepEqual(decisions, [
    ["allow", undefined],
    ["deny", undefined],
  ]);
});

test("the Allow menu offers the remembered scopes and sends the one picked", async () => {
  const { card, decisions } = mount({
    toolName: "run_command",
    summary: "Run command: npm test",
    preview: { kind: "command", command: "npm test" },
    scopes: ["once", "chat", "always"],
  });

  fireEvent.pointerDown(within(card).getByRole("button", { name: "More ways to allow" }), { button: 0, pointerType: "mouse" });
  const items = await screen.findAllByRole("menuitem");
  assert.deepEqual(
    items.map((item) => item.textContent),
    [
      "Allow for this chatWon't ask again for this exact command until Aiden quits.",
      "Always allow in this workspaceWon't ask again for this exact command here. Undo in Settings → Tool approvals.",
    ],
  );
  fireEvent.click(items[1]!);
  assert.deepEqual(decisions, [["allow", { scope: "always" }]]);
});

test("a remembered file approval says it covers any later change to that file", async () => {
  // File rules match the tool and path, not the contents, so the hint must not promise an exact change.
  const { card } = mount({ toolName: "edit_file", summary: "Edit file: src/forecast.ts", scopes: ["once", "chat", "always"] });

  fireEvent.pointerDown(within(card).getByRole("button", { name: "More ways to allow" }), { button: 0, pointerType: "mouse" });
  assert.deepEqual(
    (await screen.findAllByRole("menuitem")).map((item) => item.textContent),
    [
      "Allow for this chatWon't ask again for any edit to forecast.ts until Aiden quits.",
      "Always allow in this workspaceWon't ask again for any edit to forecast.ts here. Undo in Settings → Tool approvals.",
    ],
  );
});

test("a file edit shows the lines it removes and adds, labelled for screen readers", () => {
  const { card } = mount({
    toolName: "edit_file",
    summary: "Edit file: src/forecast.ts",
    preview: toolApprovalPreview("edit_file", {
      path: "src/forecast.ts",
      old_string: "const score = hike();\nreturn Math.floor(score);",
      new_string: "const score = hike();\nreturn Math.round(score * 10) / 10;",
    }),
  });

  assert.ok(screen.getByRole("region", { name: "Edit forecast.ts?" }));
  const change = within(card).getByRole("group", { name: "Change to src/forecast.ts" });
  assert.deepEqual(
    [...change.querySelectorAll("[data-line]")].map((line) => [line.getAttribute("data-line"), line.textContent]),
    [
      ["context", "  const score = hike();"],
      ["removed", "- Removed: return Math.floor(score);"],
      ["added", "+ Added: return Math.round(score * 10) / 10;"],
    ],
  );
  assert.ok(within(card).getByText("src/forecast.ts · 1 added, 1 removed"));
  assert.equal(within(card).queryByRole("button", { name: "More ways to allow" }), null, "no scopes were offered");
});

test("a paired host's command summary still shows just the command", () => {
  const { card } = mount({ toolName: "run_command", summary: "Run command: git status" });

  assert.ok(screen.getByRole("region", { name: "Run this command?" }));
  assert.match(card.querySelector("#approval-summary-approval-1")?.textContent ?? "", /^\$ git status$/u);
  assert.ok(within(card).getByText("Aiden is paused until you choose."));
  cleanup();

  // A paired host's file summary names its one file in the title and keeps the summary as sent.
  mount({ toolName: "edit_file", summary: "Edit file: src/forecast.ts" });
  assert.ok(screen.getByRole("region", { name: "Edit forecast.ts?" }));
  assert.ok(screen.getByText("Edit file: src/forecast.ts"));
});

test("an approval that cannot be allowed here offers only Deny", () => {
  const { card } = mount({ toolName: "run_command", summary: "Run command: ls", canAllow: false });

  assert.deepEqual(
    within(card).getAllByRole("button").map((button) => button.textContent),
    ["Deny"],
  );
  assert.ok(within(card).getByText(/cannot safely authorize this action from this view/u));
});
