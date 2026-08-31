import { PanelsTopLeft } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import type { ChatHtmlArtifactV1 } from "../shared/chat-artifacts";
import { Text } from "./ui";

export function DesignArtifactCard({
  chatId,
  artifact,
  version,
}: {
  chatId: string;
  artifact: ChatHtmlArtifactV1;
  version: number;
}) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() =>
        void navigate({
          to: "/design/$chatId",
          params: { chatId },
          search: { artifact: artifact.mediaId },
        })
      }
      className="flex min-h-14 w-full max-w-[42rem] items-center gap-3 rounded-card bg-control px-3 py-2.5 text-left outline-none transition-colors duration-150 hover:bg-control-hover active:bg-control-active focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      data-design-artifact-card={artifact.mediaId}
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-control bg-popover text-secondary shadow-control">
        <PanelsTopLeft className="size-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <Text as="span" variant="small-strong" truncate className="block">
          {artifact.title}
        </Text>
        <Text as="span" variant="small" color="tertiary" className="block text-mini">
          Design version {version} · Open workspace
        </Text>
      </span>
    </button>
  );
}
