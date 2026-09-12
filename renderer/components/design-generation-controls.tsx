import { designerApi } from "../lib/ipc";
import * as React from "react";
import type { DesignGenerationRequestV1, DesignGenerationIntentV1 } from "../shared/design-generation";
import type { DesignProjectSnapshot } from "../shared/design-projects";
import { Button, Text } from "./ui";

export const DEFAULT_DESIGN_EXPLORE: DesignGenerationRequestV1 = {
  version: 1, operation: "explore", count: 2, creativeRange: "balanced", aspects: [],
};

/** The controls describe the next attended turn; only main can resolve its ownership. */
export function DesignGenerationControls({ request, onChange, disabled, project, onChoose, onArchive, onShow }: {
  request: DesignGenerationRequestV1;
  onChange: (request: DesignGenerationRequestV1) => void;
  disabled: boolean;
  project?: DesignProjectSnapshot;
  onChoose: (setId: string, member: { lineageId: string; mediaId: string }) => Promise<void>;
  onArchive: (setId: string, archived: boolean) => Promise<void>;
  onShow: (mediaId: string) => void;
}) {
  const [showArchived, setShowArchived] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [busy, setBusy] = React.useState(false);
  const sets = project?.version === 2 ? project.directionSets ?? [] : [];
  const intents = project?.version === 2 ? project.generationIntents ?? [] : [];
  const mutate = async (action: () => Promise<void>) => {
    setBusy(true); setError(undefined);
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <section aria-label="Design generation" className="space-y-2 px-3 pt-3">
    <div className="flex flex-wrap items-center gap-2">
      <Text variant="small-strong">{request.operation === "explore" ? "Explore directions" : "Refine selected revision"}</Text>
      {request.operation === "refine" || request.base ? <Button size="small" variant="transparent" disabled={disabled} onClick={() => onChange(DEFAULT_DESIGN_EXPLORE)}>Start fresh</Button> : null}
    </div>
    {request.operation === "explore" ? <fieldset disabled={disabled} className="flex flex-wrap items-center gap-2">
      <label className="text-small text-secondary">Directions <select aria-label="Number of directions" className="rounded-control bg-control px-2 py-1 text-primary" value={request.count} disabled={Boolean(request.retryDirectionSetId)} onChange={(e) => onChange({ ...request, count: Number(e.target.value) as 2 | 3 | 4 })}>
        {[2, 3, 4].map((count) => <option key={count} value={count}>{count}</option>)}
      </select></label>
      <label className="text-small text-secondary">Range <select aria-label="Creative range" className="rounded-control bg-control px-2 py-1 text-primary" value={request.creativeRange} disabled={Boolean(request.retryDirectionSetId)} onChange={(e) => onChange({ ...request, creativeRange: e.target.value as "close" | "balanced" | "bold" })}>
        <option value="close">Close</option><option value="balanced">Balanced</option><option value="bold">Bold</option>
      </select></label>
      <div className="flex flex-wrap gap-2" aria-label="Aspects to explore">{(["layout", "color", "typography", "content"] as const).map((aspect) => <label key={aspect} className="flex items-center gap-1 text-small text-secondary"><input type="checkbox" checked={request.aspects.includes(aspect)} disabled={Boolean(request.retryDirectionSetId)} onChange={(e) => onChange({ ...request, aspects: e.target.checked ? [...request.aspects, aspect] : request.aspects.filter((item) => item !== aspect) })} />{aspect}</label>)}</div>
      {request.base ? <Text as="p" variant="small" color="secondary">Based on the selected revision. Alternatives remain separate screens.</Text> : null}
      {request.retryDirectionSetId ? <Text as="p" variant="small" color="secondary">Retrying only the missing directions.</Text> : null}
    </fieldset> : <Text as="p" variant="small" color="secondary">The next prompt creates one revision of this screen.</Text>}
    {sets.length ? <details>
      <summary className="cursor-pointer text-small text-secondary">Saved directions ({sets.length})</summary>
      <label className="flex items-center gap-2 py-2 text-small text-secondary"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />Show archived sets</label>
      <div className="max-h-48 space-y-3 overflow-auto">{sets.filter((set) => showArchived || !set.archived).map((set, index) => {
        const source = intents.find((intent) => intent.id === set.sourceIntentId)?.request;
        return <section key={set.id} aria-label={`Direction set ${index + 1}`} className="rounded-card bg-control p-2">
          <Text variant="small-strong">{set.actualCount}/{set.requestedCount} directions · {set.status}{set.archived ? " · Archived" : ""}</Text>
          <div className="flex flex-wrap gap-1">{set.members.map((member, i) => <div key={member.mediaId} className="flex items-center gap-1">
            <Button size="small" variant="transparent" onClick={() => onShow(member.mediaId)}>View {i + 1}</Button>
            <Button size="small" variant="transparent" disabled={disabled || busy} aria-pressed={set.chosen?.mediaId === member.mediaId} onClick={() => void mutate(() => onChoose(set.id, member))}>{set.chosen?.mediaId === member.mediaId ? "Chosen" : `Choose ${i + 1}`}</Button>
          </div>)}</div>
          <div className="flex flex-wrap gap-1">
            {set.status === "partial" && source?.operation === "explore" ? <Button size="small" variant="transparent" disabled={disabled || busy} onClick={() => onChange({ ...source, retryDirectionSetId: set.id })}>Retry missing</Button> : null}
            <Button size="small" variant="transparent" disabled={disabled || busy} onClick={() => void mutate(() => onArchive(set.id, !set.archived))}>{set.archived ? "Restore set" : "Archive set"}</Button>
          </div>
        </section>;
      })}</div>
    </details> : null}
    {error ? <Text as="p" variant="small" color="red" role="alert">{error}</Text> : null}
  </section>;
}

export function DesignGenerationProvenance({ projectId, mediaId }: { projectId: string; mediaId: string }) {
  const [state, setState] = React.useState<{ key: string; intent?: DesignGenerationIntentV1 | null; error?: string }>();
  const key = `${projectId}:${mediaId}`;
  React.useEffect(() => {
    let current = true;
    void designerApi.generationProvenance({ projectId, mediaId }).then(
      (intent) => { if (current) setState({ key, intent }); },
      (error) => { if (current) setState({ key, error: error instanceof Error ? error.message : String(error) }); },
    );
    return () => { current = false; };
  }, [projectId, mediaId, key]);
  if (state?.key !== key) return <Text variant="small" color="secondary">Loading generation details…</Text>;
  if (state.error) return <Text variant="small" color="red" role="alert">{state.error}</Text>;
  return <details className="max-w-full text-left"><summary className="cursor-pointer text-small">Generation details</summary>
    {state.intent ? <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-mini text-secondary">{JSON.stringify(state.intent, null, 2)}</pre> : <Text variant="small" color="secondary">Created before generation provenance was recorded.</Text>}
  </details>;
}
