import * as React from "react";
import { Tabs } from "../components/ui-primitives";
import { EmptyState } from "../components/ui";

export type SidePanelTab = "run" | "history";

const TABS = [
  { value: "run", label: "Run" },
  { value: "history", label: "History" },
] as const;

/** The editor's right column: the current run, or every image this workflow has made. */
export function EditorSidePanel({
  tab,
  onTabChange,
  run,
  history,
}: {
  tab: SidePanelTab;
  onTabChange(tab: SidePanelTab): void;
  /** The run panel, or null before this workflow has run. */
  run: React.ReactNode;
  history: React.ReactNode;
}) {
  return (
    <div className="image-side-panel flex flex-col">
      <Tabs<SidePanelTab> value={tab} onValueChange={onTabChange} items={TABS} aria-label="Run and history" className="shrink-0 px-3 pt-3" />
      <div role="tabpanel" aria-label={tab === "run" ? "Run" : "History"} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {tab === "history"
          ? history
          : run ?? <EmptyState placement="inline" title="No runs yet" description="Choose Run All to generate images. Each run's progress shows here." />}
      </div>
    </div>
  );
}
