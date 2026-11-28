import * as React from "react";
import type { SubagentRunSnapshot } from "../shared/subagent-runs";
import { resolveModelDisplay } from "./model-display";
import { useProviders, useProvidersModelInfo } from "./queries";
import type { ModelInfo } from "./types";

/** Offline catalog answers keyed by provider id, then model id (the composer picker's source). */
export type SubagentModelCatalog = Readonly<
  Record<string, Readonly<Record<string, ModelInfo | undefined>> | undefined>
>;

type SubagentModelRef = Pick<SubagentRunSnapshot, "modelId" | "providerId">;
type SubagentModelLineRef = SubagentModelRef & Pick<SubagentRunSnapshot, "thinkingLevel">;

const EFFORT_LABELS: Record<
  NonNullable<SubagentRunSnapshot["thinkingLevel"]>,
  string | undefined
> = {
  off: undefined,
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/**
 * The name a person sees for a helper's model: the same catalog display name the
 * composer's model picker shows, or a humanized id when the catalog has none.
 */
export function subagentModelName(run: SubagentModelRef, catalog?: SubagentModelCatalog): string {
  const info = run.providerId ? catalog?.[run.providerId]?.[run.modelId] : undefined;
  return resolveModelDisplay(run.modelId, info).label;
}

/** "GLM 5.3 Flash · Max"; the effort is left out when it is off or was not recorded. */
export function subagentModelLine(
  run: SubagentModelLineRef,
  catalog?: SubagentModelCatalog,
): string {
  const effort = run.thinkingLevel ? EFFORT_LABELS[run.thinkingLevel] : undefined;
  return [subagentModelName(run, catalog), effort].filter(Boolean).join(" · ");
}

const SubagentModelCatalogContext = React.createContext<SubagentModelCatalog | undefined>(
  undefined,
);

/** Shares the picker's offline model catalog with every helper surface below it. */
export function SubagentModelCatalogProvider({ children }: { children: React.ReactNode }) {
  const providers = useProviders();
  const catalog = useProvidersModelInfo(providers.data ?? []);
  return (
    <SubagentModelCatalogContext.Provider value={catalog.data}>
      {children}
    </SubagentModelCatalogContext.Provider>
  );
}

export function useSubagentModelCatalog(): SubagentModelCatalog | undefined {
  return React.useContext(SubagentModelCatalogContext);
}
