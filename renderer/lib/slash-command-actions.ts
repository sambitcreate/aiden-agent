import type { CommandId } from "../shared/keybindings";
import type { SettingsSection } from "../shared/settings-section";
import type { SlashCommandDefinition } from "../shared/slash-commands";

export interface SlashCommandActionContext {
  canExecuteCommand: (commandId: CommandId) => boolean;
  hasChat: boolean;
  hasCompletedTurn?: boolean;
  hasLatestAssistantResponse: boolean;
  hasAuthenticatedProvider?: boolean;
  hasWorkspace: boolean;
  hasWorkspaceArtifactAccess?: boolean;
  hasManagedWorktreeFlow?: boolean;
  idle: boolean;
  idleBlockedReason?: string;
  navigationBlockedReason?: string;
  composerControlBlockedReason?: string;
  environmentBlockedReason?: string;
  sessionActionBlockedReason?: string;
  chatCloneBlockedReason?: string;
  worktreeBlockedReason?: string;
  payloadAfterToken: boolean;
  hasAttachmentsOrSelectedSkill?: boolean;
}

export interface SlashCommandAvailabilityResult {
  available: boolean;
  reason?: string;
}

export interface SlashCommandArgumentResult {
  valid: boolean;
  value?: string;
  reason?: string;
}

export interface SlashCommandActionHandlers {
  executeCommand: (commandId: CommandId) => boolean;
  openSettings: (section?: SettingsSection) => void;
  requestRename: (initialTitle?: string) => void;
  copyLatestResponse: () => void | Promise<void>;
  openReview: () => void;
  openAccess: () => void;
  openFork?: () => void;
  cloneChat?: () => void | Promise<void>;
  exportChat?: () => void | Promise<void>;
  openSessionDetails?: () => void;
  openLogout?: () => void;
  openWorktree?: (branchName?: string) => void | Promise<void>;
  submitComposerInstruction?: (
    instruction: "visualize",
    prompt: string,
  ) => boolean | Promise<boolean>;
}

const unavailable = (reason: string): SlashCommandAvailabilityResult => ({
  available: false,
  reason,
});

export function slashCommandAvailability(
  command: SlashCommandDefinition,
  context: SlashCommandActionContext,
): SlashCommandAvailabilityResult {
  if (command.draftPolicy === "require-empty" && context.payloadAfterToken) {
    return unavailable("Clear the draft and attachments first.");
  }
  if (command.behavior === "navigation" && context.payloadAfterToken) {
    return unavailable("Clear the draft and attachments before navigating away.");
  }

  switch (command.availability) {
    case "chat-required":
      if (!context.hasChat) return unavailable("Open a chat first.");
      break;
    case "idle-chat-navigation":
      if (!context.idle) return unavailable("Finish the current response first.");
      break;
    case "latest-assistant-response":
      if (!context.hasLatestAssistantResponse) {
        return unavailable("There is no assistant response to copy yet.");
      }
      break;
    case "idle-chat-session":
      if (!context.hasChat) return unavailable("Open a chat first.");
      if (
        command.action.kind === "session" &&
        command.action.action === "fork" &&
        !context.hasCompletedTurn
      ) {
        return unavailable("Complete an assistant turn before forking this chat.");
      }
      if (
        command.action.kind === "session" &&
        command.action.action === "clone" &&
        context.chatCloneBlockedReason
      ) {
        return unavailable(context.chatCloneBlockedReason);
      }
      if (!context.idle) {
        return unavailable(context.idleBlockedReason ?? "Finish the current response or approval first.");
      }
      if (context.sessionActionBlockedReason) {
        return unavailable(context.sessionActionBlockedReason);
      }
      break;
    case "authenticated-provider":
      if (!context.hasAuthenticatedProvider) {
        return unavailable("There is no authenticated provider to sign out.");
      }
      break;
    case "workspace-required":
    case "workspace-terminal":
    case "workspace-environment":
    case "workspace-worktree":
      if (!context.hasWorkspace) return unavailable("Open a workspace first.");
      break;
    case "idle-workspace":
      if (!context.hasWorkspace) return unavailable("Open a workspace first.");
      if (!context.hasChat) return unavailable("Open a chat first.");
      if (!context.idle) {
        return unavailable(context.idleBlockedReason ?? "Finish the current response first.");
      }
      break;
    case "always":
      break;
  }

  if (command.action.kind === "composer-control" && context.composerControlBlockedReason) {
    return unavailable(context.composerControlBlockedReason);
  }
  if (
    command.action.kind === "composer-instruction" &&
    command.action.instruction === "visualize" &&
    context.hasWorkspaceArtifactAccess === false
  ) {
    return unavailable("Allow workspace access before creating an interactive artifact.");
  }
  if (
    (command.action.kind === "environment" ||
      (command.action.kind === "command" && command.action.commandId === "environment.toggle")) &&
    context.environmentBlockedReason
  ) {
    return unavailable(context.environmentBlockedReason);
  }
  if (command.availability === "workspace-worktree") {
    if (context.hasAttachmentsOrSelectedSkill) {
      return unavailable("Remove draft attachments and the selected skill first.");
    }
    if (!context.hasManagedWorktreeFlow) {
      return unavailable("This workspace is not an available Git worktree source.");
    }
    if (!context.idle) {
      return unavailable(context.idleBlockedReason ?? "Finish the current response first.");
    }
    if (context.worktreeBlockedReason) {
      return unavailable(context.worktreeBlockedReason);
    }
  }
  const navigatesAway =
    command.action.kind === "settings" ||
    command.availability === "idle-chat-navigation" ||
    (command.action.kind === "command" && command.action.commandId === "settings.open");
  if (navigatesAway && context.navigationBlockedReason) {
    return unavailable(context.navigationBlockedReason);
  }
  if (command.action.kind === "command" && !context.canExecuteCommand(command.action.commandId)) {
    return unavailable("This app action is unavailable right now.");
  }
  return { available: true };
}

export function validateSlashCommandArgument(
  command: SlashCommandDefinition,
  argument: string,
): SlashCommandArgumentResult {
  if (command.argument === "none") return { valid: true };
  const value = argument.trim();
  if (!value) return { valid: true };
  if (command.argument === "optional-prompt") {
    if (value.length > 4000 || /[\p{Cc}\p{Cf}]/u.test(value)) {
      return {
        valid: false,
        reason: "Enter a short visualization prompt on one line.",
      };
    }
    return { valid: true, value };
  }
  if (command.argument === "optional-title") {
    if (!/[\p{Cc}\p{Cf}]/u.test(value) && Array.from(value).length <= 120) {
      return { valid: true, value };
    }
    return {
      valid: false,
      reason: "Chat titles must be one line and no longer than 120 characters.",
    };
  }
  if (
    value.length > 100 ||
    /[\s~^:?*\\\p{Cc}\p{Cf}]/u.test(value) ||
    value.includes("[") ||
    value.includes("]") ||
    value.startsWith("/") ||
    value.startsWith(".") ||
    value.startsWith("-") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.endsWith(".lock") ||
    value.includes("..") ||
    value.includes("//") ||
    value.includes("@{")
  ) {
    return {
      valid: false,
      reason: "Enter a valid Git branch name, such as feature/my-change.",
    };
  }
  return { valid: true, value };
}

export function executeSlashCommandAction(
  command: SlashCommandDefinition,
  argument: string,
  handlers: SlashCommandActionHandlers,
): boolean | Promise<boolean> {
  switch (command.action.kind) {
    case "command":
      return handlers.executeCommand(command.action.commandId);
    case "settings":
      handlers.openSettings(command.action.section);
      return true;
    case "chat":
      if (command.action.action === "copy-latest") {
        const result = handlers.copyLatestResponse();
        return result instanceof Promise ? result.then(() => true) : true;
      } else {
        const title = argument.trim();
        handlers.requestRename(title || undefined);
      }
      return true;
    case "environment":
      handlers.openReview();
      return true;
    case "composer-control":
      handlers.openAccess();
      return true;
    case "session":
      switch (command.action.action) {
        case "fork":
          if (!handlers.openFork) return false;
          handlers.openFork();
          return true;
        case "clone": {
          if (!handlers.cloneChat) return false;
          const result = handlers.cloneChat();
          return result instanceof Promise ? result.then(() => true) : true;
        }
        case "export": {
          if (!handlers.exportChat) return false;
          const result = handlers.exportChat();
          return result instanceof Promise ? result.then(() => true) : true;
        }
        case "details":
          if (!handlers.openSessionDetails) return false;
          handlers.openSessionDetails();
          return true;
        case "logout":
          if (!handlers.openLogout) return false;
          handlers.openLogout();
          return true;
        case "worktree": {
          if (!handlers.openWorktree) return false;
          const branchName = argument.trim() || undefined;
          const result = handlers.openWorktree(branchName);
          return result instanceof Promise ? result.then(() => true) : true;
        }
      }
      return false;
    case "composer-instruction": {
      if (!handlers.submitComposerInstruction) return false;
      return handlers.submitComposerInstruction(command.action.instruction, argument.trim());
    }
  }
}

export type SlashCommandActionAttempt =
  | { kind: "sync"; handled: boolean; error?: unknown }
  | {
      kind: "async";
      completion: Promise<{ handled: boolean; error?: unknown }>;
    };

export function attemptSlashCommandAction(
  command: SlashCommandDefinition,
  argument: string,
  handlers: SlashCommandActionHandlers,
): SlashCommandActionAttempt {
  try {
    const execution = executeSlashCommandAction(command, argument, handlers);
    if (execution instanceof Promise) {
      return {
        kind: "async",
        completion: execution.then(
          (handled) => ({ handled }),
          (error: unknown) => ({ handled: false, error }),
        ),
      };
    }
    return { kind: "sync", handled: execution };
  } catch (error) {
    return { kind: "sync", handled: false, error };
  }
}
