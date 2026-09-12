import { PanelsTopLeft } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import type { ChatHtmlArtifactV1 } from "../shared/chat-artifacts";
import { designArtifactNavigationTarget } from "../lib/design-artifact-navigation";
import { Text } from "./ui";

export function DesignArtifactCard({
  chatId,
  projectId,
  artifact,
  version,
  revisionLabel,
  onShowOnCanvas,
}: {
  chatId: string;
  /** Stable Design Project identity. Falls back to the legacy chat route while old callers migrate. */
  projectId?: string;
  artifact: ChatHtmlArtifactV1;
  version: number;
  revisionLabel?: string;
  onShowOnCanvas?: (artifact: ChatHtmlArtifactV1) => void;
}) {
  const navigate = useNavigate();
  const target = designArtifactNavigationTarget({ legacyChatId: chatId, projectId, artifact });
  return (
    <button
      type="button"
      onClick={() => {
        onShowOnCanvas?.(artifact);
        void navigate({
          to: "/design/$chatId",
          params: { chatId: target.routeProjectId },
          search: target.search,
        });
      }}
      className="flex min-h-14 w-full max-w-[42rem] items-center gap-3 rounded-card bg-control px-3 py-2.5 text-left outline-none transition-colors duration-150 hover:bg-control-hover active:bg-control-active focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      data-design-artifact-card={artifact.mediaId}
      data-design-artifact-id={artifact.id}
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-control bg-popover text-secondary shadow-control">
        <PanelsTopLeft className="size-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <Text as="span" variant="small-strong" truncate className="block">
          {artifact.title}
        </Text>
        <Text as="span" variant="small" color="tertiary" className="block text-mini">
          {revisionLabel ?? `Design version ${version}`} · Show on canvas
        </Text>
      </span>
    </button>
  );
}
