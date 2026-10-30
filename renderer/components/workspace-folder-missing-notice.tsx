import { FolderX } from "lucide-react";
import { Button, Callout } from "./ui";
import { workspaceFolderMissingMessage } from "../shared/workspace-folder-presence";

/**
 * Above the composer while the chat's workspace folder is gone. Sends are
 * refused until the folder is back, so the draft stays in the composer.
 */
export function WorkspaceFolderMissingNotice({
  workspaceName,
  folder,
  checking,
  onCheckAgain,
}: {
  workspaceName: string;
  folder?: string;
  checking?: boolean;
  onCheckAgain(): void;
}) {
  return (
    <div className="aiden-dock-inset chat-content-column pb-2">
      <Callout role="status" aria-label="Workspace folder missing">
        <p className="flex items-start gap-2 text-small text-secondary">
          <FolderX className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>{workspaceFolderMissingMessage(workspaceName, folder)}</span>
        </p>
        <div className="mt-1 flex justify-end">
          <Button variant="transparent" size="small" disabled={checking} onClick={onCheckAgain}>
            {checking ? "Checking…" : "Check again"}
          </Button>
        </div>
      </Callout>
    </div>
  );
}
