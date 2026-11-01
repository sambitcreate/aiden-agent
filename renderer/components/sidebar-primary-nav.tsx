import { ChevronDown, Clock3, Images, PenTool, SquarePen } from "lucide-react";
import type { AppCapabilities } from "../lib/app-capabilities";
import { studioFeatureForPath } from "../shared/studio-routes";
import { BotSidebarIcon } from "./bot-avatar";
import { Button, SidebarListItem } from "./ui";

export type SidebarPrimaryDestination = "/scheduled" | "/bots" | "/design" | "/images";

export interface SidebarPrimaryNavProps {
  pathname: string;
  capabilities: Pick<AppCapabilities, "bots" | "designStudio" | "createImages">;
  newAgentDisabled: boolean;
  onNewAgent: () => void;
  /** Opens the New chat in… palette; shown as a chevron beside New Agent on hover or focus. */
  onNewChatIn?: () => void;
  /** ARIA form of the New chat in… shortcut, when one is bound. */
  newChatInKeyShortcut?: string;
  onNavigate: (destination: SidebarPrimaryDestination) => void;
  /** The open Bot is already selected below (its Inbox row), so Bots doesn't read as selected too. */
  openBotShownBelow?: boolean;
}

/** Top-level destinations above the workspace outline. Studio rows exist only behind their flags. */
export function SidebarPrimaryNav({
  pathname,
  capabilities,
  newAgentDisabled,
  onNewAgent,
  onNewChatIn,
  newChatInKeyShortcut,
  onNavigate,
  openBotShownBelow = false,
}: SidebarPrimaryNavProps) {
  const studio = studioFeatureForPath(pathname);
  return (
    <nav aria-label="Primary" className="flex flex-col gap-0.5 px-2.5 pb-2">
      {onNewChatIn ? (
        <div className="group/new-agent flex min-w-0 items-center gap-0.5">
          <SidebarListItem
            className="min-w-0 flex-1"
            icon={<SquarePen />}
            title="New Agent"
            disabled={newAgentDisabled}
            onClick={onNewAgent}
          />
          <Button
            variant="transparent"
            size="small"
            iconOnly
            aria-label="New chat in…"
            aria-haspopup="dialog"
            aria-keyshortcuts={newChatInKeyShortcut}
            disabled={newAgentDisabled}
            className="size-7 shrink-0 text-tertiary opacity-0 group-hover/new-agent:opacity-100 focus-visible:opacity-100"
            onClick={onNewChatIn}
          >
            <ChevronDown />
          </Button>
        </div>
      ) : (
        <SidebarListItem
          icon={<SquarePen />}
          title="New Agent"
          disabled={newAgentDisabled}
          onClick={onNewAgent}
        />
      )}
      <SidebarListItem
        icon={<Clock3 />}
        title="Scheduled"
        selected={pathname === "/scheduled"}
        onClick={() => onNavigate("/scheduled")}
      />
      {capabilities.bots ? (
        <SidebarListItem
          icon={<BotSidebarIcon />}
          title="Bots"
          selected={pathname.startsWith("/bots") && !openBotShownBelow}
          onClick={() => onNavigate("/bots")}
        />
      ) : null}
      {capabilities.designStudio ? (
        <SidebarListItem
          icon={<PenTool />}
          title="Design"
          selected={studio === "designStudio"}
          onClick={() => onNavigate("/design")}
        />
      ) : null}
      {capabilities.createImages ? (
        <SidebarListItem
          icon={<Images />}
          title="Images"
          selected={studio === "createImages"}
          onClick={() => onNavigate("/images")}
        />
      ) : null}
    </nav>
  );
}
