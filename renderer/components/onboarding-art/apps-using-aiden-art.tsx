import { AppWindow, Eye, Lock, ShieldCheck } from "lucide-react";
import { ArtChip, ArtIcon, ArtWindow, Bar, Toggle } from "./art-kit";

/** Settings → Connections → Apps using Aiden: the switch and two added apps, one just connecting. */
export function AppsUsingAidenArt() {
  return <>
    <div className="oa-stack" style={{ position: "absolute", left: 12, top: 12, gap: 5, justifyItems: "start" }}>
      <ArtChip icon={Lock}>This computer only</ArtChip>
      <ArtChip icon={ShieldCheck}>You approve</ArtChip>
    </div>
    <ArtWindow style={{ left: 120, top: 8, width: 166, padding: 10 }}>
      <div className="oa-stack" style={{ gap: 9 }}>
        <div className="oa-row" style={{ gap: 6 }}>
          <span className="oa-stack oa-grow" style={{ gap: 3 }}>
            <span className="oa-strong">Let apps use Aiden</span>
            <Bar width="70%" tone="soft" />
          </span>
          <Toggle on />
        </div>
        <div className="oa-row" style={{ gap: 6 }}>
          <ArtIcon icon={AppWindow} />
          <span className="oa-stack oa-grow" style={{ gap: 3 }}><Bar width="74%" tone="ink" /><Bar width="56%" tone="soft" /></span>
          <ArtChip icon={ShieldCheck}>Supervised</ArtChip>
        </div>
        <div className="oa-row oa-anim-pop" style={{ gap: 6, animationDelay: "0.4s" }}>
          <ArtIcon icon={AppWindow} />
          <span className="oa-stack oa-grow" style={{ gap: 3 }}><Bar width="62%" tone="ink" /><Bar width="48%" tone="soft" /></span>
          <ArtChip icon={Eye}>Read only</ArtChip>
        </div>
      </div>
    </ArtWindow>
  </>;
}
