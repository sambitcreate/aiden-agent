import { ArrowLeftRight, Check, MessageSquare, ShieldCheck } from "lucide-react";
import { ArtButton, ArtChip, ArtIcon, ArtWindow, Bar } from "./art-kit";

/** Profile pair approval and its quiet exchange detail, drawn from the shipped controls. */
export function BotPeersArt() {
  return <>
    <ArtWindow className="oa-sched" style={{ left: 14, top: 16, width: 236, height: 226 }}>
      <div className="oa-sched-title"><ArtIcon icon={ArrowLeftRight} /> Bot messaging</div>
      <div className="oa-sched-list">
        <div className="oa-sched-row"><span className="oa-sched-text"><Bar width="84%" tone="ink" /><Bar width="68%" tone="soft" /></span><ArtChip icon={Check}>Approved</ArtChip></div>
        <div className="oa-sched-row"><ArtIcon icon={ShieldCheck} /><span className="oa-sched-text"><Bar width="88%" tone="ink" /><Bar width="74%" tone="soft" /></span></div>
        <div className="oa-sched-row"><ArtIcon icon={MessageSquare} /><span className="oa-sched-text"><Bar width="72%" tone="ink" /><Bar width="54%" tone="soft" /></span></div>
      </div>
    </ArtWindow>
    <ArtWindow raised style={{ left: 102, top: 152, width: 178, padding: 12 }}>
      <div className="oa-stack" style={{ gap: 8 }}><ArtChip icon={ArrowLeftRight}>Exchange</ArtChip><Bar width="92%" /><Bar width="70%" tone="soft" /><ArtButton variant="ghost">View exchange</ArtButton></div>
    </ArtWindow>
  </>;
}
