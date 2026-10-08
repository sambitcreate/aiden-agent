import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { approvalCardTool, approvalSummary } from "../../main/services/acp/generation-host.js";
import type { AcpApprovalRequest } from "../../main/services/acp/host.js";
import { ChatApprovalCard } from "./chat-approval-card.js";

function heading(request: Omit<AcpApprovalRequest, "toolCallId" | "paths" | "offersAlways">): string {
  const full = { toolCallId: "1", paths: [], offersAlways: true, ...request };
  const html = renderToStaticMarkup(
    <ChatApprovalCard
      pending={{
        approvalId: "agent",
        toolCallId: "1",
        toolName: approvalCardTool(full),
        summary: approvalSummary("Google Antigravity", full),
        scopes: ["once", "chat"],
      }}
      deciding={false}
      onDecide={() => undefined}
    />,
  );
  const title = html.match(/id="approval-title-agent"[^>]*>([^<]+)</u)?.[1];
  assert.ok(title, "the card has a title");
  return title;
}

test("each kind of agent approval names its action the way Aiden's own cards do", () => {
  assert.equal(heading({ kind: "command", title: "npm test" }), "Run command needs approval");
  assert.equal(heading({ kind: "file_change", title: "Edit a.ts" }), "Edit file needs approval");
  // Removing or relocating files is not presented as an edit.
  assert.equal(heading({ kind: "file_change", fileChange: "delete", title: "Delete old.ts" }), "Delete file needs approval");
  assert.equal(heading({ kind: "file_change", fileChange: "move", title: "Move a.ts" }), "Move file needs approval");
  assert.equal(heading({ kind: "file_read", title: "Read .env" }), "Read file needs approval");
  assert.equal(heading({ kind: "fetch", title: "example.com" }), "Fetch web page needs approval");
  assert.equal(heading({ kind: "other", title: "Lookup" }), "Agent tool needs approval");
});

test("a delete approval says it deletes, in the summary too", () => {
  const summary = approvalSummary("Google Antigravity", {
    toolCallId: "1",
    kind: "file_change",
    fileChange: "delete",
    title: "Delete old.ts",
    paths: ["old.ts"],
    offersAlways: false,
  });
  assert.match(summary, /^Google Antigravity wants to delete files: Delete old\.ts\nFiles: old\.ts$/u);
});

test("an unknown tool's heading is sentence case, never a raw snake_case name", () => {
  const html = renderToStaticMarkup(
    <ChatApprovalCard
      pending={{ approvalId: "x", toolCallId: "1", toolName: "future_agent_tool", summary: "Do a thing" }}
      deciding={false}
      onDecide={() => undefined}
    />,
  );
  assert.match(html, /id="approval-title-x"[^>]*>Future agent tool needs approval</u);
});
