import { Blocks, Check, ChevronDown } from "lucide-react";
import { ArtButton, ArtChip, ArtIcon, ArtWindow, Bar, Radio } from "./art-kit";

/** A cropped routine model chooser, including its explicit fallback. */
export function BotRoutineModelsArt() {
  return <>
    <ArtWindow className="oa-sched" style={{ left: 14, top: 14, width: 230, height: 232 }}>
      <div className="oa-sched-title"><ArtIcon icon={Blocks} /> Routine model</div>
      <div className="oa-sched-list">
        <div className="oa-sched-row"><Radio /><span className="oa-sched-text"><span>Bot default</span><Bar width="76%" tone="soft" /></span></div>
        <div className="oa-sched-open oa-selected">
          <div className="oa-sched-row"><Radio checked /><span className="oa-sched-text"><Bar width="80%" tone="ink" /><Bar width="56%" tone="soft" /></span><ArtIcon icon={ChevronDown} /></div>
          <div className="oa-stack" style={{ gap: 8, padding: "4px 12px 12px" }}><ArtChip>Thinking · High</ArtChip><Bar width="78%" tone="soft" /></div>
        </div>
      </div>
    </ArtWindow>
    <ArtWindow raised style={{ left: 108, top: 148, width: 170, padding: 12 }}>
      <div className="oa-stack" style={{ gap: 8 }}><ArtChip icon={Check}>Fallback chosen</ArtChip><Bar width="86%" /><Bar width="62%" tone="soft" /><ArtButton variant="primary">Save</ArtButton></div>
    </ArtWindow>
  </>;
}
