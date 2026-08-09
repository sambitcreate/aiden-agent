import type { CommandId } from "../shared/keybindings";
import type { SettingsSection } from "../shared/settings-section";
import type { SlashCommandDefinition } from "../shared/slash-commands";

export interface SlashCommandActionContext {
  canExecuteCommand: (commandId: CommandId) => boolean;
  hasChat: boolean;
  hasLatestAssistantResponse: boolean;
  hasWorkspace: boolean;
  idle: boolean;
  navigationBlockedReason?: string;
  composerControlBlockedReason?: string;
  environmentBlockedReason?: string;
  payloadAfterToken: boolean;
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
    case "workspace-required":
    case "workspace-terminal":
    case "workspace-environment":
      if (!context.hasWorkspace) return unavailable("Open a workspace first.");
      break;
    case "always":
      break;
  }

  if (command.action.kind === "composer-control" && context.composerControlBlockedReason) {
    return unavailable(context.composerControlBlockedReason);
  }
  if (
    (command.action.kind === "environment" ||
      (command.action.kind === "command" && command.action.commandId === "environment.toggle")) &&
    context.environmentBlockedReason
  ) {
    return unavailable(context.environmentBlockedReason);
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
  if (/[\p{Cc}\p{Cf}]/u.test(value) || Array.from(value).length > 120) {
    return {
      valid: false,
      reason: "Chat titles must be one line and no longer than 120 characters.",
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
