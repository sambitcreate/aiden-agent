import {
  COMMANDS,
  matchesAccelerator,
  type CommandId,
  type KeyboardEventLike,
  type KeyboardPlatform,
} from "../shared/keybindings";

export interface CommandDispatchContext {
  editable: boolean;
  fileEditor: boolean;
  terminal: boolean;
  modal: boolean;
  paletteOpen: boolean;
  composing: boolean;
  repeat: boolean;
  defaultPrevented: boolean;
  recording: boolean;
}

export interface CommandExecutionContext {
  applicationModal: boolean;
  dialogOpen: boolean;
  foreignDialog: boolean;
  paletteOpen: boolean;
}

export function commandExecutionAllowed(
  commandId: CommandId,
  context: CommandExecutionContext,
): boolean {
  if (context.applicationModal) return false;
  if (!context.dialogOpen) return true;
  return (
    commandId === "commandPalette.toggle" &&
    context.paletteOpen &&
    !context.foreignDialog
  );
}

export function workspaceCommandVisibility(pathname: string): {
  environment: boolean;
  terminal: boolean;
} {
  return {
    environment: pathname !== "/settings",
    terminal:
      pathname === "/" ||
      pathname.startsWith("/chat/") ||
      /^\/bots\/[^/]+\/chat\/[^/]+$/u.test(pathname),
  };
}

export function resolveCommandForKeyEvent(
  event: KeyboardEventLike,
  bindings: Record<CommandId, string | null>,
  context: CommandDispatchContext,
  platform: KeyboardPlatform = "darwin",
): CommandId | null {
  if (context.defaultPrevented || context.composing || context.recording) return null;
  for (const definition of COMMANDS) {
    if (definition.global) continue;
    const binding = bindings[definition.id];
    if (!binding || !matchesAccelerator(event, binding, platform)) continue;
    if (context.repeat && !definition.allowRepeat) continue;
    if (
      context.modal &&
      (definition.id !== "commandPalette.toggle" || !context.paletteOpen)
    )
      continue;
    if (context.terminal && definition.id !== "terminal.toggle") continue;
    if (definition.scope === "fileEditor" && !context.fileEditor) continue;
    if (context.editable && !definition.allowInEditable) continue;
    return definition.id;
  }
  return null;
}
