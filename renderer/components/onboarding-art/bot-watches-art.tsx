import { CalendarClock, Check } from "lucide-react";
import { ArtButton, ArtChip, ArtIcon, ArtWindow, Bar, Toggle } from "./art-kit";

/** A cropped Profile watch row and its metadata-only foreground test. */
export function BotWatchesArt() {
  return <>
    <ArtWindow className="oa-sched" style={{ left: 12, top: 14, width: 228, height: 218 }}>
      <div className="oa-sched-title"><ArtIcon icon={CalendarClock} /> Connected-app watches</div>
      <div className="oa-sched-list">
        <div className="oa-sched-open oa-selected">
          <div className="oa-sched-row"><span className="oa-sched-text"><Bar width="76%" tone="ink" /><span>Calendar · Team events</span></span><Toggle on /></div>
          <div className="oa-stack" style={{ gap: 7, padding: "4px 12px 12px" }}><Bar width="82%" /><Bar width="63%" tone="soft" /><ArtChip icon={Check}>Next 2 hours</ArtChip><ArtButton variant="ghost">Test check</ArtButton></div>
        </div>
      </div>
    </ArtWindow>
    <ArtWindow raised style={{ left: 104, top: 146, width: 172, padding: 12 }}>
      <div className="oa-stack" style={{ gap: 8 }}><span className="oa-strong">Test check result</span><Bar width="86%" /><Bar width="68%" tone="soft" /><Bar width="78%" tone="soft" /></div>
    </ArtWindow>
  </>;
}
