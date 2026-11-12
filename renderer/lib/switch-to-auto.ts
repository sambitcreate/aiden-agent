// The repeat-approval nudge's offer of Auto (plan §7, deviation (a)): an
// upgrade never moves anyone to Auto, so a person who keeps allowing the same
// kind of action in Ask is offered it on the card. The switch saves the
// global mode through the ordinary settings path, which records
// `approval_mode_changed` like choosing it in Settings → Approvals.

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "../components/ui";
import { isAcpHarnessProvider } from "../shared/acp-harness";
import { effectiveApprovalMode, workspaceApprovalPolicy, type ApprovalWorkspaceFields } from "../shared/approval-mode";
import { settingsApi, type ApprovalPrompt } from "./ipc";
import { isUsable } from "./model-picker-data";
import { queryKeys, useProviders, useSettings } from "./queries";
import type { AppSettings } from "./types";

/** Allows of one kind of action in one workspace before its card offers Auto. */
export const WORKSPACE_REPEAT_THRESHOLD = 3;

const workspaceAllows = new Map<string, number>();
const tallyKey = (workspaceId: string, toolName: string) => `${workspaceId}\u0000${toolName}`;

/**
 * Count one allow of `toolName` in a workspace, for this app session only:
 * nothing is saved, so a restart starts over.
 */
export function noteWorkspaceAllow(workspaceId: string, toolName: string): void {
  const key = tallyKey(workspaceId, toolName);
  workspaceAllows.set(key, (workspaceAllows.get(key) ?? 0) + 1);
}

/**
 * A workspace card whose repeats count toward the offer: main said Auto would
 * hand this call to the judge instead (`autoWouldJudge`). A command, a file
 * change, a background job, a saved screenshot, sharing or creating an image
 * and every specialized review ask in Auto too, so they never count, and a
 * paired host's card answers to that host's mode.
 */
export function repeatableApproval(prompt: Pick<ApprovalPrompt, "autoWouldJudge" | "source">): boolean {
  return prompt.source !== "remote" && prompt.autoWouldJudge === true;
}

/** Allows of `toolName` in this workspace since Aiden opened. */
export function workspaceAllowCount(workspaceId: string, toolName: string): number {
  return workspaceAllows.get(tallyKey(workspaceId, toolName)) ?? 0;
}

/** Test seam: forget every count. */
export function resetWorkspaceAllows(): void {
  workspaceAllows.clear();
}

export interface SwitchToAutoOffer {
  switchToAuto(): void;
  switching: boolean;
}

/**
 * The offer, while this Mac is in Ask, a model could judge, and the asking
 * chat follows the Mac's mode (a workspace with its own mode does not). A
 * provider that runs only inside an agent runtime (ACP) can't judge, so it
 * doesn't count. `undefined` otherwise, including while settings or
 * providers load.
 */
export function useSwitchToAutoOffer(followsGlobalMode = true): SwitchToAutoOffer | undefined {
  const settings = useSettings();
  const providers = useProviders();
  const queryClient = useQueryClient();
  const [switching, setSwitching] = React.useState(false);
  const usable = (providers.data ?? []).some((provider) => isUsable(provider) && !isAcpHarnessProvider(provider.id));
  const offered =
    followsGlobalMode &&
    settings.data !== undefined &&
    providers.isSuccess &&
    usable &&
    effectiveApprovalMode(settings.data, usable) === "ask";
  const switchToAuto = React.useCallback(() => {
    if (switching) return;
    setSwitching(true);
    void settingsApi
      .set({ approvalMode: "auto" })
      .then((saved) => {
        queryClient.setQueryData<AppSettings>(queryKeys.settings, saved);
        toast.success("Auto is on. This card still needs your answer; from now on a model checks routine actions like it. Change it in Settings → Approvals.");
      })
      .catch(() => toast.error("Couldn’t switch to Auto."))
      .finally(() => setSwitching(false));
  }, [queryClient, switching]);
  return offered ? { switchToAuto, switching } : undefined;
}

/** The suggestion line a card shows with the offer. */
export function switchToAutoSuggestion(offer: SwitchToAutoOffer) {
  return {
    text: "Or let a model approve routine actions like this.",
    action: "Switch to Auto",
    onAction: offer.switchToAuto,
    busy: offer.switching,
  };
}

/**
 * A workspace card's repeat nudge: once the person has allowed this kind of
 * action `WORKSPACE_REPEAT_THRESHOLD` times in this workspace since Aiden
 * opened, and Auto is on offer, the card says so and offers Auto. Nothing
 * when the workspace keeps its own mode or is Chat only.
 */
export function useWorkspaceRepeatNudge(
  workspace: (ApprovalWorkspaceFields & { id: string }) | undefined,
  pending: Pick<ApprovalPrompt, "toolName" | "autoWouldJudge" | "source"> | undefined,
): { notes?: string[]; suggestion?: ReturnType<typeof switchToAutoSuggestion> } {
  const follows = workspace !== undefined && !workspaceApprovalPolicy(workspace, "ask").customized && workspace.permission !== "none";
  const offer = useSwitchToAutoOffer(follows);
  if (!offer || !workspace || !pending || !repeatableApproval(pending)) return {};
  const allows = workspaceAllowCount(workspace.id, pending.toolName);
  if (allows < WORKSPACE_REPEAT_THRESHOLD) return {};
  return { notes: [`You’ve allowed this ${allows} times since Aiden opened.`], suggestion: switchToAutoSuggestion(offer) };
}
