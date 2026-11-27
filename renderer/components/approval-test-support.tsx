import { renderToStaticMarkup } from "react-dom/server";
import { ChatApprovalCard } from "./chat-approval-card.js";
import type { ApprovalPrompt } from "../lib/ipc.js";

export function renderApprovalCard(
  details: unknown,
  prompt: Partial<ApprovalPrompt> = {},
): { markup: string; buttons: string[] } {
  const markup = renderToStaticMarkup(
    <ChatApprovalCard
      pending={{
        approvalId: "approval-1",
        toolCallId: "call-1",
        toolName: "run_command",
        summary: "summary",
        details: details as ApprovalPrompt["details"],
        ...prompt,
      }}
      deciding={false}
      onDecide={() => {}}
    />,
  );
  const buttons = [...markup.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/gu)].map((match) =>
    (match[1] ?? "").replace(/<[^>]+>/gu, "").trim(),
  );
  return { markup, buttons };
}
