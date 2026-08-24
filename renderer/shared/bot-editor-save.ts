import type { BotAvatarAppearance, BotDefinition } from "./bots";

export interface BotEditorIdentityDraft {
  name: string;
  description: string;
  instructions: string;
  avatar: BotAvatarAppearance;
}

export interface BotEditorAccessDraft {
  usesFullAccess: boolean;
  providerId: string | undefined;
  modelId: string | undefined;
  fileScopeIds: string[];
  shellEnabled: boolean;
  connectionIds: string[];
  skillIds: string[];
  otherCapabilityIds: string[];
}

function sameAvatar(left: BotAvatarAppearance, right: BotAvatarAppearance): boolean {
  return left.version === right.version
    && left.shape === right.shape
    && left.color === right.color
    && left.eyes === right.eyes
    && left.detail === right.detail;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id) => right.includes(id));
}

export function botEditorIdentityDiffers(
  draft: BotEditorIdentityDraft,
  baseline: BotEditorIdentityDraft,
): boolean {
  return draft.name.trim() !== baseline.name.trim()
    || draft.description.trim() !== baseline.description.trim()
    || draft.instructions.trim() !== baseline.instructions.trim()
    || !sameAvatar(draft.avatar, baseline.avatar);
}

/** Keep only fields the person changed; adopt unrelated authoritative edits. */
export function rebaseBotEditorIdentityDraft(
  draft: BotEditorIdentityDraft,
  baseline: BotEditorIdentityDraft,
  authoritative: BotEditorIdentityDraft,
): BotEditorIdentityDraft {
  return {
    name: draft.name.trim() === baseline.name.trim() ? authoritative.name : draft.name,
    description: draft.description.trim() === baseline.description.trim()
      ? authoritative.description
      : draft.description,
    instructions: draft.instructions.trim() === baseline.instructions.trim()
      ? authoritative.instructions
      : draft.instructions,
    avatar: sameAvatar(draft.avatar, baseline.avatar) ? authoritative.avatar : draft.avatar,
  };
}

/** Three-way merge for access/model settings using the editor's original baseline. */
export function rebaseBotEditorAccessDraft(
  draft: BotEditorAccessDraft,
  baseline: BotEditorAccessDraft,
  authoritative: BotEditorAccessDraft,
): BotEditorAccessDraft {
  // Provider and model form one binding. Keeping a user-edited model while
  // adopting a concurrently changed provider (or vice versa) can manufacture
  // a pair that never existed in either editor.
  const modelBindingChanged = draft.providerId !== baseline.providerId
    || draft.modelId !== baseline.modelId;
  return {
    usesFullAccess: draft.usesFullAccess === baseline.usesFullAccess
      ? authoritative.usesFullAccess
      : draft.usesFullAccess,
    providerId: modelBindingChanged ? draft.providerId : authoritative.providerId,
    modelId: modelBindingChanged ? draft.modelId : authoritative.modelId,
    fileScopeIds: sameIds(draft.fileScopeIds, baseline.fileScopeIds)
      ? authoritative.fileScopeIds
      : draft.fileScopeIds,
    shellEnabled: draft.shellEnabled === baseline.shellEnabled
      ? authoritative.shellEnabled
      : draft.shellEnabled,
    connectionIds: sameIds(draft.connectionIds, baseline.connectionIds)
      ? authoritative.connectionIds
      : draft.connectionIds,
    skillIds: sameIds(draft.skillIds, baseline.skillIds)
      ? authoritative.skillIds
      : draft.skillIds,
    otherCapabilityIds: sameIds(draft.otherCapabilityIds, baseline.otherCapabilityIds)
      ? authoritative.otherCapabilityIds
      : draft.otherCapabilityIds,
  };
}

export function botEditorIdentityDraftFromDefinition(
  bot: BotDefinition,
  resolveAvatar: (avatar: BotDefinition["avatar"]) => BotAvatarAppearance,
): BotEditorIdentityDraft {
  return {
    name: bot.name,
    description: bot.description ?? "",
    instructions: bot.instructions,
    avatar: resolveAvatar(bot.avatar),
  };
}
