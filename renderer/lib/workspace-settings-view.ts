// View rules for Workspace settings: which skills and connectors a
// workspace's chats can use, and why a switch can or can't change.

import { mcpServerOffersTools } from "../shared/mcp-exposure";
import { isNoWorkspace } from "./no-workspace";
import type { SkillSource } from "../shared/slash-commands";
import type { McpServer, Workspace } from "./types";
import type { WorkspaceSkillChoice } from "../../main/services/skill-registry";

export type WorkspaceSettingsTab = "general" | "skills" | "connectors";

/**
 * Only a workspace bound to a folder has its own settings. Chats without one,
 * including No workspace chats in their hidden managed folders, use Settings.
 */
export function workspaceHasOwnSettings(
  workspace: Pick<Workspace, "folderPath" | "noWorkspace"> | undefined,
): boolean {
  return Boolean(workspace?.folderPath) && !isNoWorkspace(workspace);
}

/** Adds or removes one entry, keeping the stored list sorted and free of repeats. */
export function withOffListEntry(
  list: readonly string[] | undefined,
  key: string,
  off: boolean,
): string[] {
  const next = new Set(list ?? []);
  if (off) next.add(key);
  else next.delete(key);
  return [...next].sort();
}

export interface ConnectorRowView {
  /** Usable in this workspace's chats right now. */
  on: boolean;
  /** Settings decides, so the workspace switch can't change anything. */
  lockedBySettings: boolean;
  note: string;
  tone: "neutral" | "muted";
}

export function connectorRowView(server: McpServer, offHere: boolean): ConnectorRowView {
  if (!server.enabled) {
    return { on: false, lockedBySettings: true, note: "Off in Settings", tone: "muted" };
  }
  if (!mcpServerOffersTools(server)) {
    return {
      on: false,
      lockedBySettings: true,
      note: "Off for the model in Settings → Connectors",
      tone: "muted",
    };
  }
  return offHere
    ? { on: false, lockedBySettings: false, note: "Off here", tone: "muted" }
    : { on: true, lockedBySettings: false, note: "On", tone: "neutral" };
}

export interface SkillGroup {
  id: "configured" | "workspace" | "global";
  title: string;
  skills: WorkspaceSkillChoice[];
}

const SKILL_GROUP_OF: Record<SkillSource, SkillGroup["id"]> = {
  configured: "configured",
  workspace: "workspace",
  global: "global",
  builtin: "global",
};

const SKILL_GROUP_TITLES: Record<SkillGroup["id"], string> = {
  configured: "Your skills",
  workspace: "From this folder",
  global: "Built-in and global",
};

/** Your skills, then this folder's, then built-in and global ones; empty groups are left out. */
export function groupWorkspaceSkills(
  skills: readonly WorkspaceSkillChoice[],
  query = "",
): SkillGroup[] {
  const needle = query.trim().toLocaleLowerCase();
  const matches = needle
    ? skills.filter(
        (skill) =>
          skill.name.toLocaleLowerCase().includes(needle) ||
          skill.description.toLocaleLowerCase().includes(needle),
      )
    : skills;
  return (["configured", "workspace", "global"] as const).flatMap((id) => {
    const inGroup = matches.filter((skill) => SKILL_GROUP_OF[skill.source] === id);
    return inGroup.length > 0 ? [{ id, title: SKILL_GROUP_TITLES[id], skills: inGroup }] : [];
  });
}

export function skillRowNote(skill: WorkspaceSkillChoice): string {
  if (!skill.available) return skill.unavailableReason ?? "Unavailable";
  if (skill.userOnly) return "Runs only when you ask for it by name";
  if (skill.offHere) return "Still runs if you type $" + skill.name;
  return skill.description || "On";
}

/** "7 of 9 on" for a section header. */
export function onCountLabel(on: number, total: number): string {
  return `${on} of ${total} on`;
}
