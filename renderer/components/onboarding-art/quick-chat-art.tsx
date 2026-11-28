import { ArrowUp, Clock, FolderPlus, Maximize2, MessageSquare } from "lucide-react";
import { COMMAND_BY_ID, prettyAcceleratorForPlatform } from "../../shared/keybindings";
import { ArtChip, ArtIcon, ArtWindow, Bar, TrafficLights, type ArtProps } from "./art-kit";

/**
 * Floating Quick Chat starter & mini-modal hovering over another window.
 * Uses only the shared art kit, theme tokens, and `oa-anim-*` classes so
 * Reduce Motion leaves a complete still pose.
 */
export function QuickChatArt({ platform }: ArtProps) {
  const hotkey = prettyAcceleratorForPlatform(
    COMMAND_BY_ID["quickChat.toggle"].defaultBinding,
    platform,
  );
  return (
    <>
      <ArtWindow style={{ left: 6, top: 6, width: 178, height: 112, padding: 8 }}>
        <div className="oa-row" style={{ gap: 6, marginBottom: 8 }}>
          <TrafficLights />
          <Bar width={54} tone="soft" />
        </div>
        <div className="oa-stack" style={{ gap: 5 }}>
          <Bar width="78%" tone="soft" />
          <Bar width="62%" tone="soft" />
          <Bar width="70%" tone="soft" />
        </div>
      </ArtWindow>

      <ArtWindow
        raised
        style={{
          left: 16,
          top: 22,
          width: 164,
          padding: 8,
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        <div className="oa-row" style={{ gap: 4 }}>
          <ArtChip icon={Clock}>Temporary</ArtChip>
          <span className="oa-grow" />
          <kbd className="oa-cmd-kbd">{hotkey}</kbd>
          <ArtIcon icon={Maximize2} />
        </div>

        <div className="oa-stack" style={{ gap: 4 }}>
          <div className="oa-row" style={{ gap: 4, justifyContent: "flex-end" }}>
            <Bar width={66} tone="ink" className="oa-anim-type" />
          </div>
          <div className="oa-row" style={{ gap: 4 }}>
            <ArtIcon icon={MessageSquare} />
            <Bar
              width={74}
              tone="soft"
              className="oa-anim-type"
              style={{ animationDelay: "0.35s" }}
            />
          </div>
          <Bar
            width={52}
            tone="soft"
            className="oa-anim-type"
            style={{ marginLeft: 14, animationDelay: "0.65s" }}
          />
        </div>

        <div className="oa-row" style={{ gap: 4, marginTop: 2 }}>
          <ArtChip icon={FolderPlus}>Attach…</ArtChip>
          <span className="oa-grow" />
          <span className="oa-send oa-anim-press" style={{ animationDelay: "0.9s" }}>
            <ArtIcon icon={ArrowUp} />
          </span>
        </div>
      </ArtWindow>
    </>
  );
}
