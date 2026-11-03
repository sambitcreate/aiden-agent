import type { Workspace } from "../lib/types";
import { workspaceDisplayName } from "../lib/workspace-path-display";

/**
 * The new-chat empty state's title. It names where the draft will run, and
 * the name opens the same workspace menu as the composer chip. A scratch chat
 * (created by Scratch chat, so marked `scratch`) or a No workspace chat has no
 * project to name.
 */
export function NewChatHeadline({
  workspace,
  workspaces,
  onChooseWorkspace,
}: {
  workspace?: Workspace;
  workspaces: readonly Workspace[];
  /** Opens the workspace menu; omitted while the workspace can't change (busy or blocked). */
  onChooseWorkspace?: () => void;
}) {
  if (!workspace) return <>What would you like to work on?</>;
  // Scratch and No workspace chats have no project to name.
  if (workspace.scratch || workspace.noWorkspace) return <>What’s on your mind?</>;
  const name = workspaceDisplayName(workspace, workspaces);
  return (
    <span data-new-chat-headline>
      What should we build in{" "}
      {onChooseWorkspace ? (
        <button
          type="button"
          aria-haspopup="dialog"
          title="Choose a workspace"
          onClick={onChooseWorkspace}
          className="rounded-md px-0.5 font-semibold text-primary underline decoration-tertiary decoration-1 underline-offset-4 outline-none transition-colors duration-(--motion-duration) ease-standard hover:bg-list-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        >
          {name}
        </button>
      ) : (
        <span className="font-semibold">{name}</span>
      )}
      ?
    </span>
  );
}
