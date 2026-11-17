import { Check, Clock3, ListTodo, Undo2 } from "lucide-react";
import { ArtButton, ArtChip, ArtIcon, ArtWindow, Bar } from "./art-kit";

/** The Bot Profile's task rows and their durable Undo, with body text drawn as bars. */
export function BotOpenWorkArt() {
  return <>
    <ArtWindow className="oa-sched" style={{ left: 16, top: 16, width: 232, height: 228 }}>
      <div className="oa-sched-title"><ArtIcon icon={ListTodo} /> Open work</div>
      <div className="oa-sched-list">
        <div className="oa-sched-row"><span className="oa-sched-text"><Bar width="84%" tone="ink" /><Bar width="60%" tone="soft" /></span><ArtChip>Open</ArtChip></div>
        <div className="oa-sched-row"><span className="oa-sched-text"><Bar width="70%" tone="ink" /><Bar width="82%" tone="soft" /></span><ArtChip icon={Clock3}>Waiting</ArtChip></div>
        <div className="oa-sched-row"><span className="oa-sched-text"><Bar width="78%" tone="ink" /><Bar width="54%" tone="soft" /></span><ArtChip icon={Check}>Done</ArtChip></div>
      </div>
    </ArtWindow>
    <ArtWindow raised style={{ left: 114, top: 160, width: 156, padding: 12 }}>
      <div className="oa-stack" style={{ gap: 8 }}><Bar width="92%" /><Bar width="64%" tone="soft" /><ArtButton variant="ghost" icon={Undo2}>Undo</ArtButton></div>
    </ArtWindow>
  </>;
}
