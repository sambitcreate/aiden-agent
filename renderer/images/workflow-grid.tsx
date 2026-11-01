import { ImageIcon, MoreHorizontal } from "lucide-react";
import * as React from "react";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Text } from "../components/ui";
import type { WorkflowSummary } from "../shared/images/schema";
import { imageCountLabel, relativeTime } from "./gallery-core";
import type { WorkflowImageSummary } from "./library-core";

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

export interface WorkflowCardActions {
  open(workflow: WorkflowSummary): void;
  rename(workflow: WorkflowSummary): void;
  duplicate(workflow: WorkflowSummary): void;
  remove(workflow: WorkflowSummary): void;
}

function WorkflowCard({
  workflow,
  summary,
  galleryReady,
  now,
  actions,
}: {
  workflow: WorkflowSummary;
  summary?: WorkflowImageSummary;
  galleryReady: boolean;
  now: number;
  actions: WorkflowCardActions;
}) {
  const metaId = React.useId();
  const meta = summary
    ? `${imageCountLabel(summary.count)} · ${relativeTime(summary.latest.createdAt, now, (timestamp) => dateFormat.format(timestamp))}`
    : galleryReady ? "No images yet" : null;
  return (
    <li className="image-workflow-card">
      <div className="image-workflow-card-media">
        {summary?.latest.thumbUrl ? (
          <img src={summary.latest.thumbUrl} alt="" loading="lazy" decoding="async" draggable={false} />
        ) : (
          <ImageIcon aria-hidden="true" className="size-6 text-tertiary" />
        )}
      </div>
      <div className="flex items-start gap-1 px-3 pb-2.5 pt-2">
        <div className="flex min-w-0 flex-1 flex-col">
          {/* The whole card opens the workflow (the button's hit area covers it); its name is the title alone. */}
          <button
            type="button"
            className="image-workflow-card-open truncate text-left text-strong text-primary"
            aria-describedby={meta ? metaId : undefined}
            onClick={() => actions.open(workflow)}
          >
            {workflow.title}
          </button>
          {/* A non-breaking space keeps the card's height while the gallery loads. */}
          <Text id={metaId} variant="small" color="secondary" truncate>{meta ?? " "}</Text>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="transparent" size="small" iconOnly className="image-workflow-card-menu" aria-label={`More actions for ${workflow.title}`}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => actions.rename(workflow)}>Rename…</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => actions.duplicate(workflow)}>Duplicate</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => actions.remove(workflow)}>Delete…</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

/** The Workflows view: a card per workflow with its newest image, image count and when it last made one. */
export function WorkflowGrid({
  workflows,
  summaries,
  galleryReady,
  now = Date.now(),
  actions,
}: {
  workflows: readonly WorkflowSummary[];
  summaries: ReadonlyMap<string, WorkflowImageSummary>;
  galleryReady: boolean;
  now?: number;
  actions: WorkflowCardActions;
}) {
  return (
    <ul aria-label="Image workflows" className="image-workflow-grid">
      {workflows.map((workflow) => (
        <WorkflowCard
          key={workflow.id}
          workflow={workflow}
          summary={summaries.get(workflow.id)}
          galleryReady={galleryReady}
          now={now}
          actions={actions}
        />
      ))}
    </ul>
  );
}
