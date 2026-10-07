import { Clock3, Images, PenTool, SquarePen } from "lucide-react";
import type { AppCapabilities } from "../lib/app-capabilities";
import { studioFeatureForPath } from "../shared/studio-routes";
import { BotSidebarIcon } from "./bot-avatar";
import { SidebarListItem } from "./ui";

export type SidebarPrimaryDestination = "/scheduled" | "/bots" | "/design" | "/images";

export interface SidebarPrimaryNavProps {
  pathname: string;
  capabilities: Pick<AppCapabilities, "bots" | "designStudio" | "createImages">;
  newAgentDisabled: boolean;
  onNewAgent: () => void;
  onNavigate: (destination: SidebarPrimaryDestination) => void;
}

/** Top-level destinations above the workspace outline. Studio rows exist only behind their flags. */
export function SidebarPrimaryNav({
  pathname,
  capabilities,
  newAgentDisabled,
  onNewAgent,
  onNavigate,
}: SidebarPrimaryNavProps) {
  const studio = studioFeatureForPath(pathname);
  return (
    <nav aria-label="Primary" className="flex flex-col gap-0.5 px-2.5 pb-2">
      <SidebarListItem
        icon={<SquarePen />}
        title="New Agent"
        disabled={newAgentDisabled}
        onClick={onNewAgent}
      />
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
          selected={pathname.startsWith("/bots")}
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
